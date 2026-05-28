# BolloBot Claude Interceptor

This project turns your model list into a proxy server that intercepts Anthropic Claude API requests and routes them through any model you select from your UI.

## Setup

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Configure API Keys**:
    Open the `.env` file and add your API keys for the providers you want to use (OpenAI, Anthropic, OpenRouter, DeepSeek, Grok).

3.  **Start the server**:
    ```bash
    node server.js
    ```
    The server will be running at `http://localhost:3000`.

## How to Intercept

To use this as a proxy for Claude, point your application's Anthropic base URL to:
`http://localhost:3000/v1/messages`

### Example for Python (Anthropic SDK):
```python
import anthropic

client = anthropic.Anthropic(
    api_key="anything", # Not valid but required by SDK
    base_url="http://localhost:3000"
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, world"}]
)
print(message.content)
```

## UI
Open `http://localhost:3000` in your browser to see the model list and select which model the proxy should route requests to in real-time.
