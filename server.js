/**
 * Amazon Bedrock LLM Examples with Streaming and Tool Use
 * 
 * This server demonstrates three approaches to working with Amazon Bedrock's Llama 3 model:
 * 1. Tool use with the Converse API (non-streaming)
 * 2. Streaming responses with Server-Sent Events
 * 3. Combining streaming with tool use via sentinel phrases
 * 
 * Each approach is implemented as a separate endpoint with clear documentation
 * to help you understand when and how to use each technique.
 */

// ============================================================================
// IMPORTS AND CONFIGURATION
// ============================================================================

import express from 'express';
import cors from 'cors';
import { fromIni } from '@aws-sdk/credential-providers';
import { 
    BedrockRuntimeClient, 
    InvokeModelWithResponseStreamCommand, 
    InvokeModelCommand, 
    ConverseCommand 
} from '@aws-sdk/client-bedrock-runtime';
import { config } from './config.js';

// ============================================================================
// EXPRESS SERVER SETUP
// ============================================================================

const app = express();
const port = config.server.port;

// Middleware setup
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ============================================================================
// AWS BEDROCK CLIENT SETUP
// ============================================================================

/**
 * Configure AWS SDK v3 Bedrock client
 * 
 * This uses the AWS credentials from your default profile
 * and enables credential refresh for long-running applications
 */
const bedrockClient = new BedrockRuntimeClient({
    region: config.bedrock.region,
    credentials: fromIni({ 
        profile: 'default',
        refreshWithoutReauth: true
    })
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Weather API Tool Implementation
 * 
 * This function demonstrates how to implement a tool that can be called
 * by the LLM during conversation.
 * 
 * @param {string} location - City name or location
 * @param {string} unit - Temperature unit ('celsius' or 'fahrenheit')
 * @returns {Object} Weather data including temperature, condition, etc.
 */
async function getWeatherData(location, unit = 'fahrenheit') {
    // Check if API key has been configured
    const apiKey = config.weatherApi.apiKey;
    if (apiKey === "YOUR_WEATHER_API_KEY") {
        console.error("Weather API key not configured. Please update config.js");
        return { error: "Weather API key not configured. See README.md for setup instructions." };
    }
    
    try {
        // Call the weather API
        const response = await fetch(`${config.weatherApi.baseUrl}/current.json?key=${apiKey}&q=${encodeURIComponent(location)}&aqi=no`);
        
        if (!response.ok) {
            throw new Error(`Weather API error (${response.status}): ${await response.text()}`);
        }
        
        const data = await response.json();
        
        // Format and return the weather data
        return {
            temperature: unit === "fahrenheit" ? data.current.temp_f : data.current.temp_c,
            condition: data.current.condition.text,
            location: data.location.name + ", " + data.location.region,
            humidity: data.current.humidity + "%",
            wind: unit === "fahrenheit" ? data.current.wind_mph + " mph" : data.current.wind_kph + " km/h",
            unit: unit
        };
    }
    catch (error) {
        console.error("Weather API error:", error.message);
        return { error: error.message || 'Error fetching weather data' };
    }
}

/**
 * Server-Sent Events (SSE) Helper
 * 
 * Sends a message to the client using the SSE protocol
 * 
 * @param {Object} res - Express response object
 * @param {Object} data - Data to send as JSON
 */
function sendSSEMessage(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Setup SSE Connection
 * 
 * Configures the response headers for SSE and sends an initial connection message
 * 
 * @param {Object} res - Express response object
 */
function setupSSEConnection(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial message to confirm connection
    sendSSEMessage(res, { text: "Connection established. Generating response..." });
    
    // Flush the response to ensure the client receives the initial message
    if (typeof res.flush === 'function') {
        res.flush();
    }
}

// ============================================================================
// SENTINEL PHRASE DETECTION FOR TOOL USE
// ============================================================================

/**
 * Sentinel phrases for tool use detection
 * 
 * These markers are used to identify when the model wants to call a tool
 * and when tool results are being provided back to the model
 */
const WEATHER_SENTINEL_START = "<CALL_WEATHER>";
const WEATHER_SENTINEL_END = "</CALL_WEATHER>";
const WEATHER_RESULT_START = "<WEATHER_RESULT>";
const WEATHER_RESULT_END = "</WEATHER_RESULT>";
const MAX_SENTINEL_LENGTH = Math.max(
    WEATHER_SENTINEL_START.length,
    WEATHER_SENTINEL_END.length
);

/**
 * Sentinel Phrase Detection
 * 
 * Scans the buffer for complete sentinel phrases that indicate tool use requests.
 * This function also manages the text buffer to ensure we don't emit text that's
 * part of an incomplete sentinel phrase.
 *
 * @param {string} buffer - The running text buffer from the LLM
 * @returns {Object} Result containing:
 *   - emitted: Text safe to send to the client
 *   - buffer: Updated buffer with any partial sentinel phrases
 *   - match: Tool call payload if a complete sentinel was found, otherwise null
 */
function checkForSentinelPhrases(buffer) {
    // Look for a complete tool call: <CALL_WEATHER>...payload...</CALL_WEATHER>
    const startIndex = buffer.indexOf(WEATHER_SENTINEL_START);
    if (startIndex !== -1) {
        const endIndex = buffer.indexOf(
            WEATHER_SENTINEL_END,
            startIndex + WEATHER_SENTINEL_START.length
        );
        
        if (endIndex !== -1) {
            // Extract the JSON payload between the sentinel tags
            const jsonText = buffer.slice(
                startIndex + WEATHER_SENTINEL_START.length,
                endIndex
            );
            
            // Parse the payload (safely)
            let payload = null;
            try { 
                payload = JSON.parse(jsonText); 
            } catch (e) {
                console.error("Failed to parse sentinel payload:", e);
            }
            
            // Remove the entire sentinel span from the buffer
            const newBuffer = buffer.slice(0, startIndex) + 
                              buffer.slice(endIndex + WEATHER_SENTINEL_END.length);
            
            return { 
                emitted: "", 
                buffer: newBuffer, 
                match: payload 
            };
        }
        
        // Found start tag but not end tag yet - hold all text while looking for end tag
        return { 
            emitted: "", 
            buffer, 
            match: null 
        };
    }

    // No sentinel start tag found - emit text except for a safety buffer
    // (in case a sentinel tag is starting to emerge at the end)
    if (buffer.length > MAX_SENTINEL_LENGTH) {
        const safeLength = buffer.length - MAX_SENTINEL_LENGTH;
        return {
            emitted: buffer.slice(0, safeLength),
            buffer: buffer.slice(safeLength),
            match: null
        };
    }

    // Buffer is too empty to safely emit anything yet
    return { 
        emitted: "", 
        buffer, 
        match: null 
    };
}

// ============================================================================
// BEDROCK STREAMING HELPERS
// ============================================================================

/**
 * Invoke Bedrock Llama 3 with streaming
 * 
 * Creates and sends a streaming request to Bedrock
 * 
 * @param {string} promptText - The prompt to send to the model
 * @returns {Promise} Stream response from Bedrock
 */
async function invokeStream(promptText) {
    const command = new InvokeModelWithResponseStreamCommand({
        modelId: config.bedrock.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
            prompt: `<s>[INST] \n${promptText} \n[/INST]`,
            temperature: 0.7,
            top_p: 0.9,
            max_gen_len: 1024
        })
    });
    
    return bedrockClient.send(command);
}

/**
 * Process a Bedrock streaming response
 * 
 * Handles the streaming response from Bedrock, detecting tool calls
 * and sending text to the client via SSE
 *
 * @param {Object} streamResponse - Bedrock streaming response
 * @param {Object} res - Express response object for SSE
 * @param {Function} onMatch - Callback for when a tool call is detected
 * @returns {Promise<Object|null>} The matched tool payload or null
 */
async function consumeStream(streamResponse, res, onMatch) {
    let buffer = "";
    
    for await (const part of streamResponse.body) {
        // Skip empty chunks
        if (!part.chunk?.bytes) continue;
        
        // Decode and parse the chunk
        const textDecoder = new TextDecoder('utf-8');
        const chunkText = textDecoder.decode(part.chunk.bytes);
        const parsedChunk = JSON.parse(chunkText);
        const text = parsedChunk.generation || parsedChunk.completion || "";
        
        // Add to our running buffer
        buffer += text;

        // Check for sentinel phrases and manage the buffer
        const { emitted, buffer: newBuffer, match } = checkForSentinelPhrases(buffer);
        buffer = newBuffer;

        // Send any safe text to the client
        if (emitted) {
            sendSSEMessage(res, { text: emitted });
        }
        
        // If we found a tool call, notify the callback
        if (match) {
            if (onMatch(match)) {
                return match;
            }
        }
    }
    
    // Send any remaining text in the buffer
    if (buffer) {
        sendSSEMessage(res, { text: buffer });
    }
    
    return null;
}

// ============================================================================
// API ENDPOINTS: HEALTH AND DIAGNOSTICS
// ============================================================================

/**
 * Health check endpoint
 * Simple endpoint to verify the server is running
 */
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

/**
 * Credentials check endpoint
 * Verifies that AWS credentials are valid and can access Bedrock
 */
app.get('/api/check-credentials', async (req, res) => {
    try {
        // Try to invoke the model with a minimal prompt
        const command = new InvokeModelCommand({
            modelId: config.bedrock.modelId,
            body: JSON.stringify({ prompt: "<s>[INST] Hello [/INST]", max_gen_len: 1 }),
            contentType: 'application/json'
        });
        
        await bedrockClient.send(command);
        
        // If no error was thrown, credentials are valid
        res.json({ 
            valid: true,
            modelId: config.bedrock.modelId
        });
    } catch (error) {
        // Provide helpful error information based on error type
        const helpMessage = {
            'UnrecognizedClientException': 'AWS credentials are invalid or expired. Check your ~/.aws/credentials file.',
            'AccessDeniedException': 'Your AWS credentials do not have permission to access Bedrock. Check your IAM permissions.',
        }[error.name] || 'There was an error connecting to AWS Bedrock. Check your credentials and region settings.';
        
        res.json({ 
            valid: false, 
            error: error.message,
            modelId: config.bedrock.modelId,
            help: helpMessage
        });
    }
});

// ============================================================================
// API ENDPOINT: EXAMPLE 1 - NON-STREAMING WITH TOOL USE (CONVERSE API)
// ============================================================================

/**
 * Create a tool configuration object for the weather tool
 * 
 * This defines the tool interface for the Converse API
 * 
 * @returns {Object} Tool configuration for the Converse API
 */
function createWeatherToolConfig() {
    return {
        tools: [
            {
                toolSpec: {
                    name: "weather",
                    description: "Get current weather information for a location",
                    inputSchema: {
                        json: {
                            type: "object",
                            properties: { 
                                location: { 
                                    type: "string",
                                    description: "The city and state/country"
                                },
                                unit: {
                                    type: "string",
                                    enum: ["celsius", "fahrenheit"],
                                    description: "Temperature unit"
                                }
                            },
                            required: ["location"]
                        }
                    }
                }
            }
        ]
    };
}

/**
 * EXAMPLE 1: Non-streaming endpoint with tool use
 * 
 * This endpoint demonstrates how to use the Converse API to enable
 * tool use with Bedrock models. The flow is:
 * 
 * 1. Send initial request with user prompt and tool definition
 * 2. If model wants to use tool, execute the tool and get result
 * 3. Send tool result back to model to complete the response
 * 
 * This approach does not use streaming, so the response is only
 * sent to the client after the entire process is complete.
 */
app.post('/api/generate/tools', async (req, res) => {
    try {
        const { prompt } = req.body;

        // Validate input
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Create tool configuration
        const toolConfig = createWeatherToolConfig();

        // First user turn with the prompt
        const userTurn = [
            {
                role: "user",
                content: [{ text: prompt }]
            }
        ];
        
        // STEP 1: First request to Bedrock with tool definition
        const firstResponse = await bedrockClient.send(
            new ConverseCommand({
                modelId: config.bedrock.modelId,
                messages: userTurn,
                toolConfig
            })
        );

        // If model doesn't use the tool, return the response directly
        if (firstResponse.stopReason !== "tool_use") {
            return res.json({
                response: firstResponse.output.message.content[0].text,
                toolUsed: false
            });
        }

        // STEP 2: Model wants to use the weather tool
        const toolUse = firstResponse.output.message.content[0].toolUse;
        const toolInput = toolUse.input;
        const toolUseId = toolUse.toolUseId;
        
        // Execute the weather tool with the provided input
        const weatherData = await getWeatherData(
            toolInput.location || toolInput.city, 
            toolInput.unit || "fahrenheit"
        );

        // STEP 3: Send the tool result back to the model
        const secondResponse = await bedrockClient.send(
            new ConverseCommand({
                modelId: config.bedrock.modelId,
                messages: [
                    ...userTurn,                   // original user question
                    firstResponse.output.message,  // tool_use "assistant" turn
                    {
                        role: "user",              // toolResult is wrapped in a user turn
                        content: [
                            {
                                toolResult: {
                                    toolUseId,
                                    content: [{ json: weatherData }]
                                }
                            }
                        ]
                    }
                ],
                toolConfig  // Include the same toolConfig in the second request
            })
        );

        // Return the final response with tool use information
        return res.json({
            response: secondResponse.output.message.content[0].text,
            toolUsed: true,
            weatherData,
            location: toolInput.location || toolInput.city
        });
        
    } catch (error) {
        console.error('Error generating response with tools:', error);
        return res.status(500).json({ error: 'Failed to generate response: ' + error.message });
    }
});

// ============================================================================
// API ENDPOINT: EXAMPLE 2 - SIMPLE STREAMING
// ============================================================================

/**
 * EXAMPLE 2: Simple streaming endpoint
 * 
 * This endpoint demonstrates how to stream responses from Bedrock
 * using Server-Sent Events (SSE). This is the simplest approach
 * for streaming and doesn't include tool use.
 * 
 * The flow is:
 * 1. Set up SSE connection
 * 2. Send streaming request to Bedrock
 * 3. Forward each chunk to the client as it arrives
 */
app.get('/api/generate/stream', async (req, res) => {
    try {
        const { prompt } = req.query;

        // Validate input
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Set up Server-Sent Events connection
        setupSSEConnection(res);

        // Create request body for Llama 3
        const requestBody = {
            prompt: `<s>[INST] \n${prompt} \n[/INST]`,
            temperature: 0.7,
            top_p: 0.9,
            max_gen_len: 1024
        };

        // Create and send the streaming request to Bedrock
        const streamCommand = new InvokeModelWithResponseStreamCommand({
            modelId: config.bedrock.modelId,
            body: JSON.stringify(requestBody),
            contentType: 'application/json',
            accept: 'application/json',
        });
        
        const streamResponse = await bedrockClient.send(streamCommand);
        
        // Process the chunks as they arrive
        for await (const chunk of streamResponse.body) {
            if (chunk.chunk?.bytes) {
                // Decode binary chunk to text
                const textDecoder = new TextDecoder('utf-8');
                const chunkText = textDecoder.decode(chunk.chunk.bytes);
                
                try {
                    // Parse the chunk JSON and send the generation to the client
                    const parsedChunk = JSON.parse(chunkText);
                    sendSSEMessage(res, { text: parsedChunk.generation });
                } catch (parseError) {
                    // If parsing fails, send the raw text
                    console.error('Parse error:', parseError.message);
                    sendSSEMessage(res, { text: chunkText });
                }
            }
        }
        
        // Signal completion
        sendSSEMessage(res, { done: true });
        res.end();
        
    } catch (error) {
        console.error('Error generating streaming response:', error);
        sendSSEMessage(res, { error: 'Failed to generate response: ' + error.message });
        res.end();
    }
});

// ============================================================================
// API ENDPOINT: EXAMPLE 3 - STREAMING WITH TOOL USE
// ============================================================================

/**
 * EXAMPLE 3: Streaming with tool use via sentinel phrases
 * 
 * This endpoint demonstrates how to combine streaming with tool use
 * by detecting special sentinel phrases in the model's output.
 * 
 * The flow is:
 * 1. Set up SSE connection
 * 2. Send first streaming request with system prompt that defines sentinel phrases
 * 3. Detect tool call in the stream and execute the tool
 * 4. Send second streaming request with the tool result
 * 5. Stream the final response to the client
 */
app.get('/api/generate/stream-tools', async (req, res) => {
    try {
        const { prompt } = req.query;

        // Validate input
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Set up Server-Sent Events connection
        setupSSEConnection(res);

        // Define system prompt that instructs the model how to use sentinel phrases
        const systemPrompt = 
            `You are a helpful assistant that can check the weather. When the user asks about weather in a location, 
    respond ONLY with ${WEATHER_SENTINEL_START}{"location":"CITY_NAME, STATE_NAME"}${WEATHER_SENTINEL_END} inside the USA 
    or ${WEATHER_SENTINEL_START}{"location":"CITY_NAME, REGION_NAME"}${WEATHER_SENTINEL_END} outside of the USA and wait for the result.
    When you receive weather data in the format ${WEATHER_RESULT_START}{...}${WEATHER_RESULT_END}, use that data to answer the user's question. 
    You may call the weather tool at most once per query. After you see the ${WEATHER_RESULT_END} tag, do not issue any further ${WEATHER_SENTINEL_START}.`;

        // STEP 1: First prompt → invoke → consume until tool‐call
        const firstPrompt = `System: ${systemPrompt} \nUser: ${prompt}`;
        const firstResp = await invokeStream(firstPrompt);
        
        // Process the stream until we detect a tool call
        const callPayload = await consumeStream(
            firstResp, 
            res, 
            // Stop as soon as we see the tool request
            payload => Boolean(payload?.location)
        );

        // STEP 2: If no tool was requested, close out
        if (!callPayload) {
            sendSSEMessage(res, { done: true });
            return res.end();
        }

        // STEP 3: Update the UI and invoke the tool 
        sendSSEMessage(res, {
            toolCall: "weather",
            toolArgs: JSON.stringify(callPayload)
        });
        
        // Call the weather API
        const weatherData = await getWeatherData(callPayload.location, callPayload.unit);
        sendSSEMessage(res, { toolResponse: weatherData });

        // STEP 4: Second prompt → invoke → consume to completion
        const followUp = `System: ${systemPrompt} \nUser: ${prompt} \n${WEATHER_RESULT_START} \n${JSON.stringify(weatherData)} \n${WEATHER_RESULT_END}`;
        const secondResp = await invokeStream(followUp);
        
        // Process the second stream to completion
        await consumeStream(
            secondResp,
            res,
            // Return false: we never expect another tool call
            () => false
        );

        // STEP 5: Final close
        sendSSEMessage(res, { done: true });
        res.end();
    } catch (error) {
        console.error('Error in streaming with tools:', error);
        sendSSEMessage(res, { error: 'Failed to generate response: ' + error.message });
        res.end();
    }
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Using Bedrock model: ${config.bedrock.modelId}`);
    console.log(`Access the application at http://localhost:${port}`);
});
