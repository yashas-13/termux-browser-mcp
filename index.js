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

const TurndownService = require("turndown");
const { parse } = require("node-html-parser");

const turndownService = new TurndownService();

// ... existing code ...

const TOOLS = [
  // ... existing tools ...
  {
    name: "visual_snapshot",
    description: "Take a 'textual snapshot' of a URL (Markdown conversion) for agentic reasoning.",
    schema: z.object({
      url: z.string().url().describe("The URL to snap"),
    }),
    handler: async (args) => {
      const html = await safeExec(`curl -L -A "Mozilla/5.0 (Android 12; Mobile; rv:94.0) Gecko/94.0 Firefox/94.0" "${args.url}"`);
      const root = parse(html);

      // Remove noise
      root.querySelectorAll("script, style, iframe, nav, footer").forEach(el => el.remove());

      const markdown = turndownService.turndown(root.toString());
      return {
        content: [{ type: "text", text: markdown.substring(0, 30000) }], // Limit to 30k chars
      };
    },
  },
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
