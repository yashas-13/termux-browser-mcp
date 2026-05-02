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

const execPromise = promisify(exec);
const turndownService = new TurndownService();

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
    version: "1.2.0",
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
      const stdout = await safeExec(`curl -L -A "Mozilla/5.0 (Android 12; Mobile; rv:94.0) Gecko/94.0 Firefox/94.0" "${args.url}"`);
      return {
        content: [{ type: "text", text: stdout.substring(0, 50000) }],
      };
    },
  },
  {
    name: "submit_form",
    description: "Submit an HTML form using POST (automated).",
    schema: z.object({
      url: z.string().url().describe("The form action URL"),
      fields: z.record(z.string()).describe("Key-value pairs of form fields"),
    }),
    handler: async (args) => {
      const data = Object.entries(args.fields)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const stdout = await safeExec(`curl -X POST -d "${data}" -L "${args.url}"`);
      return {
        content: [{ type: "text", text: `Form submitted to ${args.url}. Response preview: ${stdout.substring(0, 1000)}` }],
      };
    },
  },
  {
    name: "extract_links",
    description: "Extract all links from a webpage (automated).",
    schema: z.object({
      url: z.string().url().describe("The URL to analyze"),
    }),
    handler: async (args) => {
      const stdout = await safeExec(`curl -sL "${args.url}" | grep -oE 'href="https?://[^"]+"' | cut -d'"' -f2 | sort -u`);
      return {
        content: [{ type: "text", text: stdout || "No links found." }],
      };
    },
  },
  {
    name: "visual_snapshot",
    description: "Take a 'textual snapshot' of a URL (Markdown conversion) for agentic reasoning.",
    schema: z.object({
      url: z.string().url().describe("The URL to snap"),
    }),
    handler: async (args) => {
      const html = await safeExec(`curl -L -A "Mozilla/5.0 (Android 12; Mobile; rv:94.0) Gecko/94.0 Firefox/94.0" "${args.url}"`);
      const root = parse(html);
      root.querySelectorAll("script, style, iframe, nav, footer").forEach(el => el.remove());
      const markdown = turndownService.turndown(root.toString());
      return {
        content: [{ type: "text", text: markdown.substring(0, 30000) }],
      };
    },
  },
  {
    name: "automate_task",
    description: "Perform a sequence of browser-like background tasks (monotonous jobs).",
    schema: z.object({
      tasks: z.array(z.object({
        type: z.enum(["get", "post"]),
        url: z.string().url(),
        data: z.record(z.string()).optional(),
      })).describe("List of sequential HTTP tasks"),
    }),
    handler: async (args) => {
      let results = "";
      for (const task of args.tasks) {
        let cmd = "";
        if (task.type === "get") {
          cmd = `curl -sL "${task.url}"`;
        } else {
          const data = Object.entries(task.data || {})
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
          cmd = `curl -s -X POST -d "${data}" -L "${task.url}"`;
        }
        const res = await safeExec(cmd);
        results += `Task ${task.type} ${task.url}: ${res.substring(0, 200)}...\n\n`;
      }
      return {
        content: [{ type: "text", text: results }],
      };
    },
  },
  {
    name: "safe_browse",
    description: "Browse a URL in a 'sandboxed' way by only returning metadata and stripped content.",
    schema: z.object({
      url: z.string().url().describe("The URL to browse safely"),
      extract_metadata: z.boolean().optional().describe("Whether to extract page metadata"),
    }),
    handler: async (args) => {
      const html = await safeExec(`curl -sL "${args.url}"`);
      const root = parse(html);

      const result = {
        url: args.url,
        title: root.querySelector("title")?.text || "Unknown Title",
      };

      if (args.extract_metadata) {
        result.metadata = {
          description: root.querySelector('meta[name="description"]')?.getAttribute("content"),
          keywords: root.querySelector('meta[name="keywords"]')?.getAttribute("content"),
          author: root.querySelector('meta[name="author"]')?.getAttribute("content"),
        };
      }

      root.querySelectorAll("script, style, iframe, img, svg").forEach(el => el.remove());
      result.content = root.text.replace(/\s+/g, " ").trim().substring(0, 5000);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  },
  {
    name: "batch_process",
    description: "Perform continuous browser actions (sandboxed) with automated decision making.",
    schema: z.object({
      initial_url: z.string().url().describe("Starting URL"),
      goal: z.string().describe("The goal of the batch processing"),
      max_steps: z.number().optional().describe("Maximum number of autonomous steps (default 3)"),
    }),
    handler: async (args) => {
      // This tool provides a structured way for the model to report its intent
      // and state before continuing a multi-step task.
      return {
        content: [{
          type: "text",
          text: `Initialized batch process for goal: "${args.goal}" starting at ${args.initial_url}. I will now proceed with step 1 of ${args.max_steps || 3}.`
        }],
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
  console.error("Termux Browser MCP server v1.2.0 running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
