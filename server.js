const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 7777;

// In-memory conversation store
const conversations = {};

// Model Routing Configuration
let modelRoutes = {
    'sonnet': 'claude-3-5-sonnet-latest',
    'haiku': 'claude-3-5-haiku-latest',
    'opus': 'claude-3-opus-latest',
    'default': 'claude-3-5-sonnet-latest'
};

// Global state for selected target model (fallback)
let targetModel = 'gpt-4o'; 

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint to get current routes
app.get('/get-routes', (req, res) => {
    res.json(modelRoutes);
});

// Endpoint to update a specific route
app.post('/set-route', (req, res) => {
    const { source, target } = req.body;
    if (source && target) {
        modelRoutes[source] = target;
        console.log(`Route updated: [${source}] -> ${target}`);
        res.json({ success: true, routes: modelRoutes });
    } else {
        res.status(400).json({ error: 'Missing source or target' });
    }
});

// Endpoint to reset conversation (start a new chat)
app.post('/reset-chat', (req, res) => {
    const { chatId } = req.body;
    const id = chatId || 'default';
    conversations[id] = [];
    console.log(`Conversation [${id}] reset.`);
    res.json({ success: true, message: `Chat ${id} reset` });
});

// Anthropic Interception Endpoint
app.post('/v1/messages', async (req, res) => {
    const requestedModel = req.body.model || '';
    
    // Determine the target model based on the requested source model
    let activeTarget = modelRoutes['default'];
    if (requestedModel.toLowerCase().includes('sonnet')) activeTarget = modelRoutes['sonnet'];
    else if (requestedModel.toLowerCase().includes('haiku')) activeTarget = modelRoutes['haiku'];
    else if (requestedModel.toLowerCase().includes('opus')) activeTarget = modelRoutes['opus'];

    // Attempt to extract a unique session/conversation ID from common headers
    const incomingChatId = 
        req.headers['x-chat-id'] || 
        req.headers['x-conversation-id'] || 
        req.headers['anthropic-client-session-id'] || 
        req.headers['authorization']?.slice(-10) || // Use part of auth token as fallback
        'default';

    console.log(`-----------------------------------`);
    console.log(`[${new Date().toLocaleTimeString()}] Request Received`);
    console.log(`Session ID: ${incomingChatId}`);
    console.log(`Model requested by client: ${requestedModel}`);
    console.log(`Routing through Bollo Target: ${activeTarget}`);

    // Initialize history for this session if it doesn't exist
    if (!conversations[incomingChatId]) {
        console.log(`New session detected! Starting fresh history for: ${incomingChatId}`);
        conversations[incomingChatId] = [];
    }

    // Update history with incoming messages
    if (req.body.messages && Array.isArray(req.body.messages)) {
        req.body.messages.forEach(msg => {
            // Only add if not already the last message to avoid duplications 
            // from clients that send their own history
            const lastMsg = conversations[incomingChatId][conversations[incomingChatId].length - 1];
            if (!lastMsg || lastMsg.content !== msg.content || lastMsg.role !== msg.role) {
                conversations[incomingChatId].push(msg);
            }
        });
    }

    try {
        let responseData;
        let apiUrl = '';
        let headers = { 'Content-Type': 'application/json' };
        let payload = {};

        // Use the accumulated history as the source of truth for the model call
        const messagesToForward = conversations[incomingChatId].map(m => {
            let contentString = '';
            if (typeof m.content === 'string') {
                contentString = m.content;
            } else if (Array.isArray(m.content)) {
                contentString = m.content.map(c => c.text || '').join('\n');
            }
            return {
                role: m.role,
                content: contentString
            };
        });

        if (activeTarget.startsWith('openrouter:')) {
            apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
            headers['Authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
            const actualModel = activeTarget.replace('openrouter:', '');
            payload = {
                model: actualModel,
                messages: messagesToForward,
                max_tokens: req.body.max_tokens || 4096
            };
        } else if (activeTarget.startsWith('gpt') || activeTarget.startsWith('o1') || activeTarget.startsWith('o3')) {
            apiUrl = 'https://api.openai.com/v1/chat/completions';
            headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
            payload = {
                model: activeTarget,
                messages: messagesToForward,
                max_tokens: req.body.max_tokens || 4096
            };
        } else if (activeTarget.startsWith('grok')) {
            apiUrl = 'https://api.x.ai/v1/chat/completions';
            headers['Authorization'] = `Bearer ${process.env.GROK_API_KEY}`;
            payload = {
                model: activeTarget,
                messages: messagesToForward,
                max_tokens: req.body.max_tokens || 4096
            };
        } else if (activeTarget.startsWith('deepseek')) {
            apiUrl = 'https://api.deepseek.com/chat/completions';
            headers['Authorization'] = `Bearer ${process.env.DEEPSEEK_API_KEY}`;
            payload = {
                model: activeTarget,
                messages: messagesToForward,
                max_tokens: req.body.max_tokens || 4096
            };
        } else {
            // Default to Anthropic
            apiUrl = 'https://api.anthropic.com/v1/messages';
            headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
            headers['anthropic-version'] = '2023-06-01';
            payload = {
                model: activeTarget,
                messages: messagesToForward,
                max_tokens: req.body.max_tokens || 4096
            };
            
            const anthropicRes = await axios.post(apiUrl, payload, { headers });
            const result = anthropicRes.data;
            
            // Log assistant response to history
            conversations[incomingChatId].push({ role: 'assistant', content: result.content });

            return res.json({
                message: {
                    ...result,
                    stop_details: null
                },
                usage: result.usage,
                finish_reason: result.stop_reason === 'end_turn' ? 'stop' : result.stop_reason,
                via_ai_chat_service: true
            });
        }

        // Handle Chat Completion APIs
        const externalRes = await axios.post(apiUrl, payload, { headers });
        const choice = externalRes.data.choices[0];
        const assistantText = choice.message.content;

        // Log assistant response to history
        conversations[incomingChatId].push({ role: 'assistant', content: assistantText });

        const inputTokens = externalRes.data.usage.prompt_tokens;
        const outputTokens = externalRes.data.usage.completion_tokens;

        responseData = {
            message: {
                model: req.body.model,
                id: `msg_${Math.random().toString(36).substring(2, 15)}`,
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: assistantText }],
                stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason,
                stop_sequence: null,
                stop_details: null,
                usage: {
                    input_tokens: inputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
                    output_tokens: outputTokens,
                    service_tier: "standard",
                    inference_geo: "not_available"
                }
            },
            usage: {
                input_tokens: inputTokens,
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: outputTokens,
                thinking_tokens: 0,
                usd_cents: parseFloat(((inputTokens * 0.0003) + (outputTokens * 0.0012)).toFixed(3))
            },
            finish_reason: choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason,
            via_ai_chat_service: true
        };

        res.json(responseData);

    } catch (error) {
        console.error('Error proxying request:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to proxy request', details: error.message });
    }
});




app.listen(PORT, () => {
    console.log(`BolloBot Server running at http://localhost:${PORT}`);
});
