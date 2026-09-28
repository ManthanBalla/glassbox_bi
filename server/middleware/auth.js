const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'glassbox_bi_jwt_secret_dev_key_super_secure_928374';

function authenticateToken(req, res, next) {
  let token = null;

  // Check Authorization header: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies['auth_token']) {
    // Check httpOnly cookie
    token = req.cookies['auth_token'];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. Authentication required.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please log in again.'
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid authorization token.'
    });
  }
}

function generateAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      auth_provider: user.auth_provider
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = {
  authenticateToken,
  generateAuthToken
};
