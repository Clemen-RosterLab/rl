import { runPublicCli } from "./public-cli.js";

process.exitCode = await runPublicCli(process.argv.slice(2));
