const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const { exec } = require("child_process");
const { promisify } = require("util");

const execPromise = promisify(exec);

/**
 * Robust execution wrapper
 */
async function safeExec(cmd) {
  try {
    const { stdout, stderr } = await execPromise(cmd);
    if (stderr && stderr.trim()) {
      console.error(`Termux browser command stderr: ${stderr}`);
    }
    return stdout;
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Termux command failed: ${error.message}`
    );
  }
}

const server = new Server(
  {
    name: "termux-browser",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOLS = [
  {
    name: "open_url",
    description: "Open a URL in the default Android browser.",
    schema: z.object({
      url: z.string().url().describe("The URL to open"),
    }),
    handler: async (args) => {
      await safeExec(`termux-open-url "${args.url}"`);
      return {
        content: [{ type: "text", text: `Opened URL: ${args.url}` }],
      };
    },
  },
  {
    name: "search",
    description: "Perform a Google search in the default browser.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
    handler: async (args) => {
      const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
      await safeExec(`termux-open-url "${url}"`);
      return {
        content: [{ type: "text", text: `Searching for: ${args.query}` }],
      };
    },
  },
  {
    name: "get_page_source",
    description: "Fetch the HTML source of a URL (background).",
    schema: z.object({
      url: z.string().url().describe("The URL to fetch"),
    }),
    handler: async (args) => {
      // Use curl to get source without opening browser
      const stdout = await safeExec(`curl -L -A "Mozilla/5.0 (Android 12; Mobile; rv:94.0) Gecko/94.0 Firefox/94.0" "${args.url}"`);
      return {
        content: [{ type: "text", text: stdout.substring(0, 50000) }], // Limit to 50k chars
      };
    },
  },
  {
    name: "browse_and_speak",
    description: "Open a URL and read a summary of the page using TTS.",
    schema: z.object({
      url: z.string().url().describe("The URL to browse"),
    }),
    handler: async (args) => {
      await safeExec(`termux-open-url "${args.url}"`);
      // Fetch source to get title or meta description for TTS
      const source = await safeExec(`curl -sL "${args.url}" | head -n 100`);
      const titleMatch = source.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1] : "the page";
      const text = `Opening ${title} in your browser.`;
      await safeExec(`termux-tts-speak "${text}"`);
      return {
        content: [{ type: "text", text: text }],
      };
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, schema }) => {
    const jsonSchema = {
      type: "object",
      properties: {},
      required: [],
    };

    if (schema && schema.shape) {
      for (const [key, value] of Object.entries(schema.shape)) {
        jsonSchema.properties[key] = {
          type: "string",
          description: value.description,
        };
        if (!value.isOptional()) {
          jsonSchema.required.push(key);
        }
      }
    }

    return {
      name,
      description,
      inputSchema: jsonSchema,
    };
  }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
  }

  try {
    const validatedArgs = tool.schema.parse(request.params.arguments || {});
    return tool.handler(validatedArgs);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments: ${error.errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`
      );
    }
    throw error;
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Termux Browser MCP server v1.1.0 running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
