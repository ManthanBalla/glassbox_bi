/**
 * GlassBox-BI Dashboard Logic
 * Handles session validation, navbar interactions, user dropdown,
 * onboarding walkthrough toggle, drag-and-drop file upload, and dataset removal.
 */

let currentUser = null;

// Format file size in human-readable units
function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Format timestamp
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Simple toast notification
function showToast(message, type = 'info') {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    `;
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  const bgColor = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#1e293b';
  toast.style.cssText = `
    background: ${bgColor};
    color: #ffffff;
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: flex;
    align-items: center;
    gap: 8px;
    pointer-events: auto;
    animation: fadeIn 0.2s ease-out;
  `;
  toast.innerHTML = `<span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -------------------------------------------------------------
// 1. SESSION VALIDATION & INITIALIZATION
// -------------------------------------------------------------
async function initDashboard() {
  try {
    const res = await api.get('/api/auth/me');
    if (!res.success) {
      window.location.href = '/login.html';
      return;
    }

    currentUser = res.user;
    updateUserInterface(currentUser, res.dbInfo);
    setupNavbarInteractions();
    setupGuideSection();
    setupUploadWidget();
    loadDatasets();
  } catch (err) {
    window.location.href = '/login.html';
  }
}

// Update UI elements with user info
function updateUserInterface(user, dbInfo) {
  // Avatars
  const initials = user.full_name
    ? user.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
    : 'U';

  const avatarCircle = document.getElementById('user-avatar-circle');
  if (avatarCircle) avatarCircle.textContent = initials;

  const drawerAvatarCircle = document.getElementById('drawer-avatar-circle');
  if (drawerAvatarCircle) drawerAvatarCircle.textContent = initials;

  // Profile names
  const profileName = document.getElementById('user-profile-name');
  if (profileName) profileName.textContent = user.full_name || user.email;

  const dropdownName = document.getElementById('dropdown-full-name');
  if (dropdownName) dropdownName.textContent = user.full_name;

  const dropdownEmail = document.getElementById('dropdown-email');
  if (dropdownEmail) dropdownEmail.textContent = user.email;

  const drawerName = document.getElementById('drawer-user-name');
  if (drawerName) drawerName.textContent = user.full_name;

  const drawerEmail = document.getElementById('drawer-user-email');
  if (drawerEmail) drawerEmail.textContent = user.email;

  // DB Status Indicator
  if (dbInfo) {
    const dbBadge = document.getElementById('db-status-badge');
    if (dbBadge) {
      dbBadge.textContent = dbInfo.engine.toUpperCase();
      dbBadge.title = `Database: ${dbInfo.name} (${dbInfo.host})`;
      if (dbInfo.isPostgres) {
        dbBadge.className = 'badge badge-teal';
      } else {
        dbBadge.className = 'badge badge-navy';
      }
    }
  }
}

// -------------------------------------------------------------
// 2. NAVBAR & PROFILE DROPDOWN LOGIC
// -------------------------------------------------------------
function setupNavbarInteractions() {
  // Static "Ask GlassBox-BI" element
  const askStatic = document.getElementById('ask-glassbox-static');
  if (askStatic) {
    askStatic.addEventListener('click', () => {
      showToast('Ask GlassBox-BI conversational interface is ready for query input.', 'info');
    });
  }

  // Profile dropdown toggle
  const profileBtn = document.getElementById('profile-menu-button');
  const dropdown = document.getElementById('profile-dropdown');

  if (profileBtn && dropdown) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.toggle('open');
      profileBtn.classList.toggle('active', isOpen);
    });

    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && !profileBtn.contains(e.target)) {
        dropdown.classList.remove('open');
        profileBtn.classList.remove('active');
      }
    });
  }

  // Logout triggers
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  const drawerLogoutBtn = document.getElementById('btn-drawer-logout');
  if (drawerLogoutBtn) {
    drawerLogoutBtn.addEventListener('click', handleLogout);
  }

  // Mobile drawer controls
  const navToggleBtn = document.getElementById('nav-toggle-btn');
  const drawerOverlay = document.getElementById('mobile-drawer-overlay');
  const drawer = document.getElementById('mobile-drawer');
  const drawerCloseBtn = document.getElementById('drawer-close-btn');

  function openDrawer() {
    if (drawerOverlay && drawer) {
      drawerOverlay.classList.add('open');
      drawer.classList.add('open');
    }
  }

  function closeDrawer() {
    if (drawerOverlay && drawer) {
      drawerOverlay.classList.remove('open');
      drawer.classList.remove('open');
    }
  }

  if (navToggleBtn) navToggleBtn.addEventListener('click', openDrawer);
  if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);
}

async function handleLogout() {
  try {
    await api.post('/api/auth/logout');
  } catch (e) {
    // Proceed regardless
  }
  window.location.href = '/login.html';
}

// -------------------------------------------------------------
// 3. "HOW TO USE" ONBOARDING WALKTHROUGH
// -------------------------------------------------------------
function setupGuideSection() {
  const guideCard = document.getElementById('guide-card');
  const toggleBtn = document.getElementById('btn-toggle-guide');
  const dismissBtn = document.getElementById('btn-dismiss-guide');
  const STORAGE_KEY = 'glassbox_guide_collapsed';

  if (!guideCard) return;

  // Restore user's collapsed state from localStorage
  const isCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
  if (isCollapsed) {
    guideCard.classList.add('collapsed');
    if (toggleBtn) toggleBtn.querySelector('.guide-toggle-text').textContent = 'Show Guide';
  }

  function toggleGuide(e) {
    if (e) e.stopPropagation();
    const nowCollapsed = guideCard.classList.toggle('collapsed');
    localStorage.setItem(STORAGE_KEY, nowCollapsed ? 'true' : 'false');
    if (toggleBtn) {
      toggleBtn.querySelector('.guide-toggle-text').textContent = nowCollapsed ? 'Show Guide' : 'Hide Guide';
    }
  }

  const guideHeader = document.getElementById('guide-header');
  if (guideHeader) guideHeader.addEventListener('click', toggleGuide);
  if (toggleBtn) toggleBtn.addEventListener('click', toggleGuide);

  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      guideCard.style.display = 'none';
      localStorage.setItem('glassbox_guide_dismissed', 'true');
    });
  }

  if (localStorage.getItem('glassbox_guide_dismissed') === 'true') {
    guideCard.style.display = 'none';
  }
}

// -------------------------------------------------------------
// 4. FILE UPLOAD WIDGET & DATASETS
// -------------------------------------------------------------
function setupUploadWidget() {
  const dropzone = document.getElementById('upload-dropzone');
  const fileInput = document.getElementById('dataset-file-input');
  const browseBtn = document.getElementById('btn-browse-file');
  const progressContainer = document.getElementById('upload-progress-container');
  const progressFill = document.getElementById('upload-progress-fill');
  const progressPercent = document.getElementById('upload-progress-percent');
  const uploadErrorEl = document.getElementById('upload-error-message');

  if (!dropzone || !fileInput) return;

  // Click on dropzone or browse button opens file picker
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  // Drag-and-drop events
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFileUpload(fileInput.files[0]);
      fileInput.value = ''; // Reset input
    }
  });

  // Upload handler with validation & progress bar
  async function handleFileUpload(file) {
    uploadErrorEl.textContent = '';
    uploadErrorEl.style.display = 'none';

    // Client-side extension validation: .csv, .xls, .xlsx ONLY
    const ext = file.name.split('.').pop().toLowerCase();
    const validExtensions = ['csv', 'xls', 'xlsx'];

    if (!validExtensions.includes(ext)) {
      uploadErrorEl.textContent = `Invalid file format: "${file.name}". Accepted formats are .csv, .xls, and .xlsx ONLY.`;
      uploadErrorEl.style.display = 'block';
      showToast('Upload rejected: Invalid file format', 'error');
      return;
    }

    // Display progress bar
    progressContainer.classList.add('active');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';

    const formData = new FormData();
    formData.append('dataset', file);

    try {
      const response = await api.upload('/api/datasets/upload', formData, (percent) => {
        progressFill.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
      });

      if (response.success) {
        showToast(`Dataset "${file.name}" uploaded successfully!`, 'success');
        setTimeout(() => {
          progressContainer.classList.remove('active');
          progressFill.style.width = '0%';
        }, 1000);
        loadDatasets();
      } else {
        throw new Error(response.message || 'Upload failed');
      }
    } catch (err) {
      progressContainer.classList.remove('active');
      uploadErrorEl.textContent = err.message || 'File upload failed. Please try again.';
      uploadErrorEl.style.display = 'block';
      showToast(err.message || 'File upload error', 'error');
    }
  }
}

// -------------------------------------------------------------
// 5. LOAD & RENDER DATASETS
// -------------------------------------------------------------
async function loadDatasets() {
  const container = document.getElementById('datasets-list-container');
  const emptyState = document.getElementById('datasets-empty-state');
  if (!container) return;

  try {
    const res = await api.get('/api/datasets');
    if (!res.success) return;

    const datasets = res.datasets;

    if (datasets.length === 0) {
      container.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    container.innerHTML = datasets.map(item => {
      const extClass = item.file_type.toLowerCase();
      return `
        <div class="dataset-item" id="dataset-row-${item.id}">
          <div class="dataset-info">
            <div class="dataset-format-icon ${extClass}">
              ${item.file_type}
            </div>
            <div class="dataset-details">
              <h4>${item.file_name}</h4>
              <div class="dataset-meta">
                <span>${formatBytes(item.file_size)}</span>
                <span>•</span>
                <span>${formatDate(item.uploaded_at)}</span>
                <span>•</span>
                <span class="badge badge-teal">${item.status}</span>
              </div>
            </div>
          </div>
          <div class="dataset-actions">
            <button class="btn btn-secondary btn-sm" onclick="removeDataset(${item.id}, '${item.file_name.replace(/'/g, "\\'")}')" style="color: #ef4444; border-color: #fee2e2;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              Remove
            </button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load datasets:', err);
  }
}

async function removeDataset(id, name) {
  if (!confirm(`Are you sure you want to remove dataset "${name}"?`)) {
    return;
  }

  try {
    const res = await api.delete(`/api/datasets/${id}`);
    if (res.success) {
      showToast(`Dataset "${name}" removed.`, 'success');
      loadDatasets();
    } else {
      showToast(res.message || 'Could not delete dataset.', 'error');
    }
  } catch (err) {
    showToast('Failed to delete dataset.', 'error');
  }
}

window.removeDataset = removeDataset;
window.initDashboard = initDashboard;
