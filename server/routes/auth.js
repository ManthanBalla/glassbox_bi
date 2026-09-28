const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const db = require('../db');
const { authenticateToken, generateAuthToken } = require('../middleware/auth');
const { loginLimiter, forgotPasswordLimiter } = require('../middleware/rateLimiter');
const { sendPasswordResetEmail, getLastSentDevResetLink } = require('../services/email');

const router = express.Router();

// Password validation regex helper
// Rule: min 8 chars, at least 1 number, at least 1 special character
function validatePasswordStrength(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/\d/.test(password)) {
    return 'Password must contain at least one number.';
  }
  if (!/[!@#$%^&*(),.?":{}|<>\-_=+]/.test(password)) {
    return 'Password must contain at least one special character (!@#$%^&*...).';
  }
  return null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// -------------------------------------------------------------
// 1. REGISTER
// -------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { full_name, email, password, confirm_password } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ success: false, field: 'full_name', message: 'Full name is required.' });
    }

    if (!email || !isValidEmail(email.trim())) {
      return res.status(400).json({ success: false, field: 'email', message: 'Please enter a valid email address.' });
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return res.status(400).json({ success: false, field: 'password', message: passwordError });
    }

    if (password !== confirm_password) {
      return res.status(400).json({ success: false, field: 'confirm_password', message: 'Passwords do not match.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if email already registered
    const existing = await db.query('SELECT id, auth_provider FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        field: 'email',
        message: 'An account with this email already exists. Please log in.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const insertResult = await db.query(
      `INSERT INTO users (full_name, email, password_hash, auth_provider, created_at, updated_at)
       VALUES ($1, $2, $3, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, full_name, email, auth_provider`,
      [full_name.trim(), normalizedEmail, passwordHash]
    );

    const newUser = insertResult.rows[0];

    return res.status(201).json({
      success: true,
      message: 'Account created successfully! Please log in with your credentials.',
      user: {
        id: newUser.id,
        full_name: newUser.full_name,
        email: newUser.email
      }
    });
  } catch (err) {
    console.error('[Register Error]', err);
    return res.status(500).json({ success: false, message: 'Server error during registration. Please try again.' });
  }
});

// -------------------------------------------------------------
// 2. LOGIN (with rate limiting)
// -------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !isValidEmail(email.trim())) {
      return res.status(400).json({ success: false, field: 'email', message: 'Please enter a valid email address.' });
    }

    if (!password) {
      return res.status(400).json({ success: false, field: 'password', message: 'Password is required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const user = userRes.rows[0];

    if (user.auth_provider === 'google' && !user.password_hash) {
      return res.status(400).json({
        success: false,
        message: 'This account was created with Google OAuth. Please click "Continue with Google" to sign in.'
      });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const token = generateAuthToken(user);

    // Set HTTP-only secure cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        auth_provider: user.auth_provider
      }
    });
  } catch (err) {
    console.error('[Login Error]', err);
    return res.status(500).json({ success: false, message: 'Server error during login. Please try again.' });
  }
});

// -------------------------------------------------------------
// 3. FORGOT PASSWORD (with rate limiting)
// -------------------------------------------------------------
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email.trim())) {
      return res.status(400).json({ success: false, field: 'email', message: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Find user
    const userRes = await db.query('SELECT id, full_name, email FROM users WHERE email = $1', [normalizedEmail]);

    // ALWAYS return confirmation message for security to avoid email enumeration
    const genericResponse = {
      success: true,
      message: 'If this email exists, a password reset link has been sent.'
    };

    if (userRes.rows.length === 0) {
      return res.json(genericResponse);
    }

    const user = userRes.rows[0];

    // Generate secure random token and compute SHA-256 hash for storage
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiration

    // Invalidate any previous unused tokens for this user
    await db.query('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1', [user.id]);

    // Store token hash in database (protects against database leaks)
    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at, used, created_at)
       VALUES ($1, $2, $3, FALSE, CURRENT_TIMESTAMP)`,
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${baseUrl}/reset-password.html?token=${rawToken}`;

    // Dispatch email via Gmail SMTP
    const emailResult = await sendPasswordResetEmail({
      to: user.email,
      fullName: user.full_name,
      resetUrl
    });

    // In development or test mode, provide test link to test runners without exposing in production
    if (process.env.NODE_ENV !== 'production' && (!process.env.SMTP_USER || req.headers['x-test-suite'] === 'true')) {
      genericResponse.devResetUrl = resetUrl;
      genericResponse.devNote = 'Automated test mode: reset link provided.';
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error('[Forgot Password Error]', err);
    return res.status(500).json({ success: false, message: 'Server error processing request. Please try again.' });
  }
});

// -------------------------------------------------------------
// 4. VALIDATE RESET TOKEN
// -------------------------------------------------------------
router.get('/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ valid: false, message: 'Reset token is required.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Check token by hash (or raw for legacy tokens)
    const tokenRes = await db.query(
      `SELECT prt.*, u.email, u.full_name
       FROM password_reset_tokens prt
       JOIN users u ON prt.user_id = u.id
       WHERE prt.token = $1 OR prt.token = $2`,
      [tokenHash, token]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ valid: false, message: 'Invalid reset token.' });
    }

    const tokenRecord = tokenRes.rows[0];

    if (tokenRecord.used === 1 || tokenRecord.used === true || tokenRecord.used === 't') {
      return res.status(400).json({ valid: false, message: 'This reset token has already been used.' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, message: 'This reset token has expired. Please request a new one.' });
    }

    return res.json({
      valid: true,
      email: tokenRecord.email,
      fullName: tokenRecord.full_name
    });
  } catch (err) {
    console.error('[Validate Reset Token Error]', err);
    return res.status(500).json({ valid: false, message: 'Error validating reset token.' });
  }
});

// -------------------------------------------------------------
// 5. RESET PASSWORD
// -------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password, confirm_password } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Reset token is missing.' });
    }

    const passwordError = validatePasswordStrength(new_password);
    if (passwordError) {
      return res.status(400).json({ success: false, field: 'new_password', message: passwordError });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ success: false, field: 'confirm_password', message: 'Passwords do not match.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Verify token validity by hash or raw
    const tokenRes = await db.query(
      `SELECT * FROM password_reset_tokens WHERE token = $1 OR token = $2`,
      [tokenHash, token]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or unrecognized reset token.' });
    }

    const tokenRecord = tokenRes.rows[0];

    if (tokenRecord.used === 1 || tokenRecord.used === true || tokenRecord.used === 't') {
      return res.status(400).json({ success: false, message: 'This reset link has already been used.' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'This reset link has expired. Please request a new link.' });
    }

    // Hash new password using bcrypt 12 rounds
    const newPasswordHash = await bcrypt.hash(new_password, 12);

    // Update user's password in PostgreSQL
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newPasswordHash, tokenRecord.user_id]
    );

    // Mark token used (single-use enforcement)
    await db.query(
      `UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
      [tokenRecord.id]
    );

    return res.json({
      success: true,
      message: 'Your password has been successfully updated. You can now log in.'
    });
  } catch (err) {
    console.error('[Reset Password Error]', err);
    return res.status(500).json({ success: false, message: 'Server error resetting password.' });
  }
});

// -------------------------------------------------------------
// 6. CURRENT USER / ME
// -------------------------------------------------------------
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userRes = await db.query(
      'SELECT id, full_name, email, auth_provider, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const dbInfo = db.getDbInfo();

    return res.json({
      success: true,
      user: userRes.rows[0],
      dbInfo
    });
  } catch (err) {
    console.error('[Me Error]', err);
    return res.status(500).json({ success: false, message: 'Error retrieving user profile.' });
  }
});

// -------------------------------------------------------------
// 7. LOGOUT
// -------------------------------------------------------------
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// -------------------------------------------------------------
// 8. GOOGLE OAUTH 2.0
// -------------------------------------------------------------

// Check Google OAuth configuration status or get redirect URL
router.get('/google/status', (req, res) => {
  const isConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return res.json({
    configured: isConfigured,
    clientIdConfigured: Boolean(process.env.GOOGLE_CLIENT_ID)
  });
});

// Initiates official Google OAuth flow
router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect(`/login.html?oauth_error=${encodeURIComponent('Google OAuth credentials not configured in .env.')}`);
  }

  // Generate cryptographic state for CSRF protection during OAuth flow
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000 // 10 minutes
  });

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: redirectUri,
    client_id: clientId,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    state,
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' ')
  };

  const qs = new URLSearchParams(options).toString();
  return res.redirect(`${rootUrl}?${qs}`);
});

// Official Google OAuth 2.0 callback
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/login.html?oauth_error=${encodeURIComponent(`Google OAuth error: ${error}`)}`);
  }

  if (!code) {
    return res.redirect(`/login.html?oauth_error=No_code_provided`);
  }

  const storedState = req.cookies && req.cookies['oauth_state'];
  if (state && storedState && state !== storedState) {
    return res.redirect(`/login.html?oauth_error=${encodeURIComponent('Security check failed: invalid OAuth state parameter.')}`);
  }
  res.clearCookie('oauth_state');

  try {
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

    // Exchange authorization code using official Google OAuth2 client
    const { OAuth2Client } = require('google-auth-library');
    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    let email, fullName, googleId;

    if (tokens.id_token) {
      const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId
      });
      const payload = ticket.getPayload();
      email = payload.email.toLowerCase();
      fullName = payload.name || payload.given_name || 'Google User';
      googleId = payload.sub;
    } else {
      const profileResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const googleUser = profileResponse.data;
      email = googleUser.email.toLowerCase();
      fullName = googleUser.name || googleUser.given_name || 'Google User';
      googleId = googleUser.id;
    }

    // Check if user already exists in PostgreSQL
    let userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;

    if (userRes.rows.length === 0) {
      // Create user
      const insertRes = await db.query(
        `INSERT INTO users (full_name, email, auth_provider, google_id, created_at, updated_at)
         VALUES ($1, $2, 'google', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, full_name, email, auth_provider`,
        [fullName, email, googleId]
      );
      user = insertRes.rows[0];
    } else {
      user = userRes.rows[0];
      // Update google_id if not present
      if (!user.google_id) {
        await db.query('UPDATE users SET google_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [googleId, user.id]);
      }
    }

    const token = generateAuthToken(user);

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.redirect('/dashboard.html?auth=google_success');
  } catch (oauthErr) {
    const errorData = oauthErr.response ? oauthErr.response.data : null;
    const errorDesc = errorData && errorData.error_description ? errorData.error_description : oauthErr.message;
    console.error('[Google OAuth Error]', errorData || oauthErr.message);
    return res.redirect(`/login.html?oauth_error=${encodeURIComponent(`Google authentication failed: ${errorDesc}`)}`);
  }
});

// Developer Demo Login for Google OAuth (allows full testing before Google Cloud Console keys are provided)
router.post('/google/dev-preview', async (req, res) => {
  try {
    const demoEmail = 'enterprise.analyst@glassbox-bi.ai';
    const demoName = 'Enterprise Analytics Lead';
    const demoGoogleId = 'mock_google_id_9827341';

    let userRes = await db.query('SELECT * FROM users WHERE email = $1', [demoEmail]);
    let user;

    if (userRes.rows.length === 0) {
      const insertRes = await db.query(
        `INSERT INTO users (full_name, email, auth_provider, google_id, created_at, updated_at)
         VALUES ($1, $2, 'google', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, full_name, email, auth_provider`,
        [demoName, demoEmail, demoGoogleId]
      );
      user = insertRes.rows[0];
    } else {
      user = userRes.rows[0];
    }

    const token = generateAuthToken(user);

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      message: 'Demo Google Authentication successful',
      token,
      user
    });
  } catch (err) {
    console.error('[Dev Google Login Error]', err);
    return res.status(500).json({ success: false, message: 'Demo authentication failed.' });
  }
});

module.exports = router;
