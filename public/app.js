/**
 * Amazon Bedrock LLM Streaming with Tool Use - Frontend Implementation
 * 
 * This script handles the client-side implementation of the streaming interface,
 * including establishing the SSE connection, processing streamed responses,
 * and displaying tool calls and their responses.
 */

// Global variable to store the current EventSource connection
let currentEventSource = null;

/**
 * Initiates or stops a streaming response from the server
 * Uses Server-Sent Events (SSE) to receive chunks in real-time
 */
async function generateStreamingResponse() {
    const promptElement = document.getElementById('prompt');
    const responseElement = document.getElementById('response');
    const streamButton = document.getElementById('streamButton');
    
    // If we're already streaming, stop the stream
    if (currentEventSource) {
        stopStream();
        return;
    }
    
    // Disable button while processing
    streamButton.disabled = true;
    
    try {
        const prompt = promptElement.value.trim();
        
        // Input validation
        if (!prompt) {
            responseElement.innerHTML = '<p style="color: orange;">Please enter a prompt.</p>';
            streamButton.disabled = false;
            return;
        }

        // Prepare the response area
        responseElement.innerHTML = '<p><strong>Response:</strong> </p>';
        const responseParagraph = document.createElement('p');
        responseElement.appendChild(responseParagraph);
        
        // Change button text to "Stop Stream"
        streamButton.textContent = "Stop Stream";
        streamButton.disabled = false;
        
        // Establish SSE connection to the streaming API endpoint
        currentEventSource = new EventSource(`/api/generate/stream?prompt=${encodeURIComponent(prompt)}`);
        
        // Handle incoming messages from the stream
        currentEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // Handle different types of messages
                if (data.error) {
                    // Display error message
                    responseElement.innerHTML = `<p style="color: red;">Error: ${data.error}</p>`;
                    stopStream();
                } else if (data.done) {
                    // Stream completed
                    stopStream();
                } else if (data.toolCall) {
                    // Display tool call in a highlighted box
                    const toolDiv = document.createElement('div');
                    toolDiv.className = 'tool-call';
                    toolDiv.innerHTML = `<p><strong>Using tool:</strong> ${data.toolCall}</p>
                                        <pre>${JSON.stringify(JSON.parse(data.toolArgs), null, 2)}</pre>`;
                    responseElement.appendChild(toolDiv);
                } else if (data.toolResponse) {
                    // Display tool response in a highlighted box
                    const responseDiv = document.createElement('div');
                    responseDiv.className = 'tool-response';
                    responseDiv.innerHTML = `<p><strong>Tool response:</strong></p>
                                            <pre>${JSON.stringify(data.toolResponse, null, 2)}</pre>`;
                    responseElement.appendChild(responseDiv);
                } else if (data.text) {
                    // Append text to the response area
                    responseParagraph.textContent += data.text;
                }
            } catch (error) {
                console.error('Error parsing data:', error);
            }
        };
        
        // Handle connection errors
        currentEventSource.onerror = () => {
            responseElement.innerHTML += '<p style="color: red;">Connection error. Please try again.</p>';
            stopStream();
        };
        
    } catch (error) {
        responseElement.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
        stopStream();
    }
}

/**
 * Stops the current stream and resets the UI
 */
function stopStream() {
    const streamButton = document.getElementById('streamButton');
    
    // Close the EventSource connection if it exists
    if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
    }
    
    // Reset button text and enable
    streamButton.textContent = "Generate Response";
    streamButton.disabled = false;
}