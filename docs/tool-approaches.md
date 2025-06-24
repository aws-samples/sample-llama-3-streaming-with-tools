# Comparing Two Approaches to Implementing Tool Use

This project includes two different approaches to implementing tool use with LLMs.

## 1. Converse API with Explicit Tool Definitions

This approach uses Amazon Bedrock's Converse API to formally define and use tools with the LLM.

### How It Works:

1. **Formal Tool Definition:**
   ```javascript
   const toolConfig = {
     tools: [{
       toolSpec: {
         name: "weather",
         description: "Get current weather information for a location",
         inputSchema: {
           json: {
             type: "object",
             properties: { 
               location: { type: "string" },
               unit: { type: "string", enum: ["celsius", "fahrenheit"] }
             },
             required: ["location"]
           }
         }
       }
     }]
   };
   ```

2. **Multi-Step Interaction Process:**
   - First request: Send user prompt + tool definitions
   - Model decides to use a tool and returns a `toolUse` object
   - Server executes the tool with parameters from the model
   - Second request: Send original prompt + model's tool request + tool results
   - Model incorporates tool results in final response

3. **Structured Data Exchange:**
   - The model explicitly formats its tool requests in a structured JSON format
   - Tool results are provided back as structured JSON data

### Advantages:
- **Cleaner Integration:** The model understands tool capabilities through schemas
- **Parameter Validation:** Input validation via the schema definition
- **Multiple Tools Support:** Easily define multiple tools with different capabilities
- **Deterministic Behavior:** More predictable tool invocation

### Limitations:
- **Added Latency:** Requires multiple API calls
- **Non-Streaming:** Doesn't work with streaming responses
- **More Complex Implementation:** Requires handling multi-turn conversations

## 2. Streaming with Tool Use via Sentinel Phrases

This approach uses special sentinel phrases to detect when the model wants to use a tool, allowing for tool use within streaming responses.

### How It Works:

1. **Sentinel Phrase Detection:**
   ```javascript
   const WEATHER_SENTINEL_START = "<CALL_WEATHER>";
   const WEATHER_SENTINEL_END = "</CALL_WEATHER>";
   
   function checkForSentinelPhrases(buffer) {
     // Look for a complete tool call: <CALL_WEATHER>...payload...</CALL_WEATHER>
     const startIndex = buffer.indexOf(WEATHER_SENTINEL_START);
     if (startIndex !== -1) {
       const endIndex = buffer.indexOf(
         WEATHER_SENTINEL_END,
         startIndex + WEATHER_SENTINEL_START.length
       );
       
       if (endIndex !== -1) {
         // Extract and parse the JSON payload between the sentinel tags
         const jsonText = buffer.slice(
           startIndex + WEATHER_SENTINEL_START.length,
           endIndex
         );
         
         let payload = null;
         try { 
           payload = JSON.parse(jsonText); 
         } catch (e) {
           console.error("Failed to parse sentinel payload:", e);
         }
         
         return { payload, buffer: /* updated buffer */ };
       }
     }
     return { payload: null, buffer };
   }
   ```

2. **System Prompt Engineering:**
   ```javascript
   const systemPrompt = 
     `You are a helpful assistant that can check the weather. When the user asks about weather in a location, 
     respond ONLY with ${WEATHER_SENTINEL_START}{"location":"CITY_NAME, STATE_NAME"}${WEATHER_SENTINEL_END} inside the USA 
     or ${WEATHER_SENTINEL_START}{"location":"CITY_NAME, REGION_NAME"}${WEATHER_SENTINEL_END} outside of the USA and wait for the result.
     When you receive weather data in the format ${WEATHER_RESULT_START}{...}${WEATHER_RESULT_END}, use that data to answer the user's question.`;
   ```

3. **Stream Buffer Management:**
   - As the model streams text, maintain a buffer
   - Continuously analyze the buffer for sentinel phrases
   - When a complete sentinel phrase is detected, extract the payload and remove the sentinel from the buffer
   - Execute the tool with the extracted parameters
   - Send a second prompt to the model with the tool result, using different sentinel phrases

### Advantages:
- **Works with Streaming:** Compatible with real-time text generation
- **Lower Latency:** More responsive than multiple separate API calls
- **Structured Data:** Gets properly structured JSON data unlike pattern matching
- **More Natural UX:** Users see the model "thinking" about using tools
- **Precise Tool Parameters:** Extracts exact parameters as JSON from the sentinel phrases

### Limitations:
- **System Prompt Engineering:** Requires careful crafting of system prompts to teach the model to use sentinels
- **Buffer Management Complexity:** Need to carefully track text buffer to identify and remove sentinels
- **Model Compliance:** Relies on the model to correctly format sentinel phrases
- **Additional Processing:** Requires continuous analysis of the streaming text

## Key Implementation Differences

1. **Request Structure:**
   - Converse API: Structured JSON with formal tool definitions
   - Sentinel Phrase: Standard LLM text generation with specialized system prompts

2. **Processing Flow:**
   - Converse API: Multi-step process with explicit tool use requests
   - Sentinel Phrase: Multi-stage streaming with dynamic buffer analysis

3. **Client-Server Communication:**
   - Converse API: Complete response after all tool calls finish
   - Sentinel Phrase: Tool calls and responses interspersed with generated text

4. **Error Handling:**
   - Converse API: Structured error reporting in the tool result
   - Sentinel Phrase: Error handling during JSON parsing and stream processing

## Use Case Considerations

- **Converse API** is better for:
  - Complex tools with many parameters
  - Critical applications where precision matters
  - When streaming isn't required
  - Formal/business applications

- **Sentinel Phrase** is better for:
  - Real-time conversational interfaces
  - When combining streaming with tool use is essential
  - When user experience and low latency are priorities
  - Applications that need structured tool parameters but with streaming UX

Both approaches demonstrate the evolving capabilities of LLMs to interact with external tools, each with its own trade-offs regarding implementation complexity, user experience, and reliability. The sentinel phrase technique is particularly significant because it enables tool use in streaming contexts, which is not officially supported by many LLM platforms for certain models.
