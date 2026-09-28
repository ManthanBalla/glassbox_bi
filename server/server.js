const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const db = require('./db');
const { csrfMiddleware, generateCsrfToken } = require('./middleware/csrf');
const authRoutes = require('./routes/auth');
const datasetsRoutes = require('./routes/datasets');
const preprocessingRoutes = require('./routes/preprocessing');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy if deployed
app.set('trust proxy', 1);

// Core Middleware
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CSRF Cookie Init & Protection Middleware
app.use(csrfMiddleware);

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// CSRF Token Provider Endpoint
app.get('/api/csrf-token', (req, res) => {
  const token = req.cookies['XSRF-TOKEN'] || generateCsrfToken();
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return res.json({ csrfToken: token });
});

// System Health & Diagnostics
app.get('/api/health', (req, res) => {
  return res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    db: db.getDbInfo()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/datasets', datasetsRoutes);
app.use('/api/agents/preprocessing', preprocessingRoutes);

// Clean Route Handlers for Frontend HTML Pages
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/agents/preprocessing', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agents', 'preprocessing.html'));
});


// Default Root Redirect
app.get('/', (req, res) => {
  if (req.cookies && req.cookies['auth_token']) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

// 404 Handler for APIs
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'API route not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Global Server Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'An unexpected server error occurred.'
  });
});

// Initialize Database and Start Server
async function startServer() {
  try {
    await db.initializeDatabase();
    app.listen(PORT, () => {
      console.log(`\n============================================================`);
      console.log(`  GlassBox-BI Enterprise Analytics Platform`);
      console.log(`  Server running at: http://localhost:${PORT}`);
      console.log(`  Active Database:  ${db.getDbInfo().name} (${db.getDbInfo().engine})`);
      console.log(`============================================================\n`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

startServer();
