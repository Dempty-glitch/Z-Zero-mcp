// Stands in for @modelcontextprotocol/sdk/server/stdio.js inside the MCP under
// test: the server talks to the test's client over an in-memory pipe.
class StdioServerTransport {
    constructor() {
        const t = globalThis.__zzServerTransport;
        if (!t) throw new Error("__zzServerTransport not set before the MCP server was loaded");
        return t;
    }
}
module.exports = { StdioServerTransport };
