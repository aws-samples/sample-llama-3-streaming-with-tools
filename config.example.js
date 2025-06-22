/**
 * Configuration example settings for the application.
 * 
 * DO NOT MODIFY THIS FILE
 * 
 * IMPORTANT: Copy this file to config.js and replace placeholder values with your actual credentials.
 * DO NOT commit your actual config.js file to version control.
 *
 * NOTE: You need to obtain your own free API key from https://www.weatherapi.com/
 * and replace the placeholder below with your key.
 * 
 */

export const config = {
    // Weather API configuration
    weatherApi: {
        // Replace with your own API key from https://www.weatherapi.com/
        apiKey: "YOUR_WEATHER_API_KEY",
        baseUrl: "https://api.weatherapi.com/v1"
    },
    
    // Server configuration
    server: {
        port: 3000
    },
    
    // Bedrock configuration
    bedrock: {
        region: "us-east-1",
        modelId: "us.meta.llama3-2-90b-instruct-v1:0"
    }
};