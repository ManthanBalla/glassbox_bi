/**
 * Runner to start both the Python Preprocessing Agent microservice (port 8001)
 * and the Express Backend (port 3000) concurrently.
 */

const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

const projectRoot = path.join(__dirname, '..', '..');

console.log('============================================================');
console.log('  Starting GlassBox-BI Platform Services');
console.log('============================================================');

// 1. Start Python Preprocessing Microservice
const pythonProcess = spawn('python', ['agents/preprocessing/service.py'], {
  cwd: projectRoot,
  env: { ...process.env, PYTHONPATH: path.join(projectRoot, 'agents', 'preprocessing') },
  stdio: 'inherit'
});

pythonProcess.on('error', (err) => {
  console.error('[Python Agent Service Error]', err.message);
});

// 2. Start Express Backend
const nodeProcess = spawn('node', ['server/server.js'], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit'
});

nodeProcess.on('error', (err) => {
  console.error('[Express Backend Error]', err.message);
});

// Handle graceful shutdown
function shutdown() {
  console.log('\nShutting down all GlassBox-BI services...');
  try { pythonProcess.kill('SIGTERM'); } catch (e) {}
  try { nodeProcess.kill('SIGTERM'); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
