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

// 1. Start Python Preprocessing Microservice (port 8001)
const preprocessingProcess = spawn('python', ['agents/preprocessing/service.py'], {
  cwd: projectRoot,
  env: { ...process.env, PYTHONPATH: path.join(projectRoot, 'agents', 'preprocessing') },
  stdio: 'inherit'
});

preprocessingProcess.on('error', (err) => {
  console.error('[Preprocessing Agent Service Error]', err.message);
});

// 2. Start Python Forecasting Microservice (port 8002)
const forecastingProcess = spawn('python', ['agents/forecasting/service.py'], {
  cwd: projectRoot,
  env: { ...process.env, PYTHONPATH: path.join(projectRoot, 'agents', 'forecasting') },
  stdio: 'inherit'
});

forecastingProcess.on('error', (err) => {
  console.error('[Forecasting Agent Service Error]', err.message);
});

// 3. Start Express Backend (port 3000)
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
  try { preprocessingProcess.kill('SIGTERM'); } catch (e) {}
  try { forecastingProcess.kill('SIGTERM'); } catch (e) {}
  try { nodeProcess.kill('SIGTERM'); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
