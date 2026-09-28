/**
 * GlassBox-BI API Client
 * Handles CSRF token injection, JSON payloads, and network error handling
 */

let cachedCsrfToken = null;

// Read cookie by name helper
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

// Fetch CSRF token from server
async function getCsrfToken() {
  const cookieVal = getCookie('XSRF-TOKEN');
  if (cookieVal) {
    cachedCsrfToken = cookieVal;
    return cookieVal;
  }

  try {
    const res = await fetch('/api/csrf-token');
    const data = await res.json();
    if (data.csrfToken) {
      cachedCsrfToken = data.csrfToken;
      return cachedCsrfToken;
    }
  } catch (err) {
    console.warn('[CSRF] Could not retrieve fresh CSRF token:', err);
  }
  return cachedCsrfToken || '';
}

const api = {
  async get(url) {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    return res.json();
  },

  async post(url, data = {}) {
    const csrfToken = await getCsrfToken();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async delete(url) {
    const csrfToken = await getCsrfToken();
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken
      }
    });
    return res.json();
  },

  upload(url, formData, onProgress) {
    return new Promise(async (resolve, reject) => {
      const csrfToken = await getCsrfToken();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.setRequestHeader('Accept', 'application/json');

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            onProgress(percent);
          }
        };
      }

      xhr.onload = () => {
        try {
          const response = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(response);
          } else {
            reject(response);
          }
        } catch (e) {
          reject({ success: false, message: 'Invalid server response' });
        }
      };

      xhr.onerror = () => {
        reject({ success: false, message: 'Network connection error during file upload.' });
      };

      xhr.send(formData);
    });
  }
};

window.api = api;
