import twilio from 'twilio';
const { MessagingResponse } = twilio.twiml;

const createMcpApi = (sessionToken) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `sessionId=${sessionToken}`,
  };

  const fetchJson = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    return response.json();
  };

  return {
    async executeTask(prompt) {
      const timestamp = Math.floor(Date.now() / 1000);
      const url = `https://www.mcp.run/api/profiles/~/default/tasks/twilio-task/runs/run-${timestamp}`;
      return {
        taskId: `run-${timestamp}`,
        response: await fetchJson(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ parameters: { prompt } }),
        }),
      };
    },

    async pollTaskStatus(url, { maxAttempts = 30, pollInterval = 1000, maxWaitTime = 30000 } = {}) {
      const startTime = Date.now();
      let attempts = 0;

      while (attempts < maxAttempts && Date.now() - startTime <= maxWaitTime) {
        const statusData = await fetchJson(url, { headers });

        if (statusData.status === 'ready') {
          const final = statusData.results.find((r) => r.msg === 'final message');
          return { status: 'ready', content: final?.lastMessage?.content };
        }
        if (statusData.status === 'error') {
          return { status: 'error' };
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        attempts++;
      }

      throw new Error('Polling exceeded limits');
    },
  };
};

async function handleRequest(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

	const { pathname } = new URL(request.url);
  const nonce = pathname.split('/').pop();

  // Check for nonce, you can set this to whatever you want
  if (nonce !== env.SECRET_NONCE) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, MCP_RUN_TOKEN } = env;
    if (!MCP_RUN_TOKEN) throw new Error('Missing MCP session token');

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const formData = await request.formData();
    const body = formData.get('Body') || '';
    const from = formData.get('From');
    const to = formData.get('To');

    const api = createMcpApi(MCP_RUN_TOKEN);
    const twiml = new MessagingResponse();
    twiml.message("I'm working on your request. I'll text you back when it's done...");

		// TODO this should be a queued task using durable objects
    ctx.waitUntil(
      (async () => {
        try {
          const { taskId } = await api.executeTask(body);
          const pollUrl = `https://www.mcp.run/api/profiles/~/default/tasks/twilio-task/runs/${taskId}`;
          const result = await api.pollTaskStatus(pollUrl);

          const messageBody =
            result.status === 'ready' && result.content
              ? result.content
              : "Sorry, I wasn't able to process your request successfully.";
          await client.messages.create({ to: from, from: to, body: messageBody });
        } catch {
          await client.messages.create({
            to: from,
            from: to,
            body: "Sorry, something went wrong while processing your request.",
          });
        }
      })()
    );

    return new Response(twiml.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
