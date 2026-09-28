const crypto = require('crypto');

const CSRF_SECRET = process.env.CSRF_SECRET || 'glassbox-bi-csrf-default-secret-salt';

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfMiddleware(req, res, next) {
  // Ensure XSRF-TOKEN cookie exists
  let token = req.cookies && req.cookies['XSRF-TOKEN'];
  if (!token) {
    token = generateCsrfToken();
    res.cookie('XSRF-TOKEN', token, {
      httpOnly: false, // Accessible by JavaScript to attach to headers
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
    if (!req.cookies) req.cookies = {};
    req.cookies['XSRF-TOKEN'] = token;
  }

  // Safe HTTP methods bypass verification
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Bypass CSRF for specific endpoints like OAuth callbacks if needed
  if (req.path.startsWith('/api/auth/google/callback')) {
    return next();
  }

  const clientToken = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  const cookieToken = req.cookies && req.cookies['XSRF-TOKEN'];

  // Accept token if clientToken matches cookieToken, or if clientToken is valid hex token in development
  if (!clientToken || (!cookieToken && process.env.NODE_ENV === 'production') || (cookieToken && clientToken !== cookieToken)) {
    return res.status(403).json({
      success: false,
      message: 'Invalid or missing CSRF token. Please refresh the page and try again.',
      csrfRequired: true
    });
  }

  next();
}

module.exports = {
  csrfMiddleware,
  generateCsrfToken
};
