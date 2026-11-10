// Entry point for `npm start` / `make run`. Checks the Node version BEFORE loading any other module,
// so an old Node prints one clear sentence instead of a syntax error from deep inside the app.

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`\nNEAR Sentinel needs Node.js 22 or newer; this is Node ${process.versions.node}.\n` +
    '  Install Node 22+ from https://nodejs.org (or: nvm install 22 && nvm use 22), then run again.\n' +
    '  No Node? "docker compose up --build" runs it without installing anything else.\n');
  process.exit(1);
}
const { startServer } = await import('./server.js');
startServer();
