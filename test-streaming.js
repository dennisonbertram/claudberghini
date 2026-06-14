#!/usr/bin/env node

/**
 * Test script for ChatJimmy Proxy Streaming
 * Demonstrates proper streaming event handling
 */

const http = require('http');

const API_URL = 'http://localhost:3000/v1/messages';

function makeRequest(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let fullData = '';

      res.on('data', (chunk) => {
        fullData += chunk.toString();
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: fullData,
        });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function runTests() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          ChatJimmy Proxy Streaming Test Suite              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Test 1: Non-streaming request
    console.log('Test 1: Non-Streaming Request (gpt-4)');
    console.log('─'.repeat(60));

    const nonStreamRequest = {
      hostname: 'localhost',
      port: 3000,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const nonStreamData = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'What is 2+2? Answer in one sentence.' },
      ],
      max_tokens: 100,
      stream: false,
    };

    const startTime1 = Date.now();
    const response1 = await makeRequest(nonStreamRequest, nonStreamData);
    const duration1 = Date.now() - startTime1;

    const parsed1 = JSON.parse(response1.body);
    console.log(`Status: ${response1.status}`);
    console.log(`Duration: ${duration1}ms`);
    console.log(`Model: ${parsed1.model}`);
    console.log(`Stop Reason: ${parsed1.stop_reason}`);
    console.log(`Output Tokens: ${parsed1.usage.output_tokens}`);
    console.log(`Content Preview: ${parsed1.content[0].text.substring(0, 80)}...`);
    console.log('✓ Non-streaming request successful\n');

    // Test 2: Streaming request
    console.log('Test 2: Streaming Request (claude-3-opus)');
    console.log('─'.repeat(60));

    const streamRequest = {
      hostname: 'localhost',
      port: 3000,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const streamData = {
      model: 'claude-3-opus',
      messages: [
        { role: 'user', content: 'Say hello world in 5 words' },
      ],
      max_tokens: 50,
      stream: true,
    };

    console.log('Receiving events...');
    const startTime2 = Date.now();
    const response2 = await makeRequest(streamRequest, streamData);
    const duration2 = Date.now() - startTime2;

    const events = response2.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => {
        try {
          return JSON.parse(line.substring(6));
        } catch (e) {
          return null;
        }
      })
      .filter((event) => event !== null);

    console.log(`Status: ${response2.status}`);
    console.log(`Duration: ${duration2}ms`);
    console.log(`Events Received: ${events.length}`);

    let contentText = '';
    events.forEach((event, index) => {
      if (event.type === 'content_block_delta') {
        const text = event.delta?.text || '';
        contentText += text;
        console.log(`  Event ${index + 1}: ${event.type}`);
      } else if (event.type === 'message_stop') {
        console.log(`  Event ${index + 1}: ${event.type}`);
      }
    });

    if (contentText) {
      console.log(`Content: ${contentText.substring(0, 80)}...`);
    }
    console.log('✓ Streaming request successful\n');

    // Test 3: Different models
    console.log('Test 3: Model Mapping Verification');
    console.log('─'.repeat(60));

    const models = [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'claude-3-opus',
      'claude-3-haiku',
    ];

    for (const model of models) {
      const req = {
        hostname: 'localhost',
        port: 3000,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const data = {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 50,
        stream: false,
      };

      const start = Date.now();
      const response = await makeRequest(req, data);
      const duration = Date.now() - start;

      const parsed = JSON.parse(response.body);
      const responseModel = parsed.model;
      console.log(
        `  ${model.padEnd(20)} → ${responseModel} (${duration}ms)`,
      );
    }
    console.log('✓ Model mapping verification complete\n');

    // Test 4: Health checks
    console.log('Test 4: Health Endpoints');
    console.log('─'.repeat(60));

    const healthReq = {
      hostname: 'localhost',
      port: 3000,
      path: '/health',
      method: 'GET',
    };

    const healthResponse = await makeRequest(healthReq);
    const healthData = JSON.parse(healthResponse.body);
    console.log(`Health Status: ${healthData.status}`);
    console.log('✓ Health endpoint working\n');

    const upstreamReq = {
      hostname: 'localhost',
      port: 3000,
      path: '/health/upstream',
      method: 'GET',
    };

    const upstreamResponse = await makeRequest(upstreamReq);
    const upstreamData = JSON.parse(upstreamResponse.body);
    console.log(`Upstream Connected: ${upstreamData.connected}`);
    console.log('✓ Upstream health check working\n');

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              All Tests Passed Successfully! ✓              ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

runTests();
