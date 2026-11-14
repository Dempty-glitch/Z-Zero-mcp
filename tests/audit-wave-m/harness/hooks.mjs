// Module hooks (sync, cover require() too — the MCP build is CommonJS): swap the
// stdio transport and playwright for the test shims, only for the MCP under test.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const targetDist = path.join(process.env.ZZ_TARGET, "dist") + path.sep;
const fromTarget = (ctx) => !!ctx.parentURL && decodeURIComponent(ctx.parentURL).includes(targetDist);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (fromTarget(context) && specifier === "@modelcontextprotocol/sdk/server/stdio.js") {
            return { url: pathToFileURL(path.join(here, "stdio-shim.cjs")).href, shortCircuit: true };
        }
        if (fromTarget(context) && specifier === "playwright") {
            return { url: pathToFileURL(path.join(here, "playwright-shim.cjs")).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
