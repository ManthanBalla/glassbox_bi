/**
 * GlassBox-BI: Data Preprocessing Agent Controller
 * Manages 4-step workflow, data inspection, config dispatch, live polling,
 * explainability audit log rendering, and time-series visualization.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Global State
  let currentUser = null;
  let availableDatasets = [];
  let selectedDataset = null;
  let activeSheetName = null;
  let activeProfile = null;
  let currentJobId = null;
  let pollingInterval = null;
  let chartInstance = null;

  // DOM Elements
  const alertBanner = document.getElementById('agent-alert-banner');
  const userProfileName = document.getElementById('user-profile-name');
  const userAvatarCircle = document.getElementById('user-avatar-circle');
  const dropdownFullName = document.getElementById('dropdown-full-name');
  const dropdownEmail = document.getElementById('dropdown-email');
  const btnLogout = document.getElementById('btn-logout');
  const profileButton = document.getElementById('profile-menu-button');
  const profileDropdown = document.getElementById('profile-dropdown');

  // Stepper Elements
  const stepPanels = {
    1: document.getElementById('panel-step-1'),
    2: document.getElementById('panel-step-2'),
    3: document.getElementById('panel-step-3'),
    4: document.getElementById('panel-step-4')
  };
  const stepperSteps = {
    1: document.getElementById('stepper-step-1'),
    2: document.getElementById('stepper-step-2'),
    3: document.getElementById('stepper-step-3'),
    4: document.getElementById('stepper-step-4')
  };

  // Helper: Display Alert Banner
  function showAlert(msg, type = 'error') {
    if (!alertBanner) return;
    alertBanner.textContent = msg;
    alertBanner.className = `alert alert-${type}`;
    alertBanner.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function hideAlert() {
    if (alertBanner) alertBanner.style.display = 'none';
  }

  // Helper: Switch Stepper
  function goToStep(stepNum) {
    hideAlert();
    Object.keys(stepPanels).forEach(s => {
      const isCurrent = parseInt(s) === stepNum;
      stepPanels[s].classList.toggle('active', isCurrent);
      if (parseInt(s) < stepNum) {
        stepperSteps[s].className = 'stepper-step completed';
      } else if (isCurrent) {
        stepperSteps[s].className = 'stepper-step active';
      } else {
        stepperSteps[s].className = 'stepper-step';
      }
    });
  }

  // -------------------------------------------------------------
  // 1. AUTHENTICATION CHECK & PROFILE DROPDOWN
  // -------------------------------------------------------------
  async function initAuth() {
    try {
      const data = await api.get('/api/auth/me');
      if (!data.success || !data.user) {
        window.location.href = '/login.html';
        return;
      }
      currentUser = data.user;

      if (userProfileName) userProfileName.textContent = currentUser.full_name || 'Analyst';
      if (dropdownFullName) dropdownFullName.textContent = currentUser.full_name || 'Analyst';
      if (dropdownEmail) dropdownEmail.textContent = currentUser.email || '';
      if (userAvatarCircle) {
        const initials = (currentUser.full_name || 'U').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        userAvatarCircle.textContent = initials;
      }

      // Profile menu toggle
      if (profileButton && profileDropdown) {
        profileButton.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = profileDropdown.style.display === 'block';
          profileDropdown.style.display = isExpanded ? 'none' : 'block';
          profileButton.setAttribute('aria-expanded', !isExpanded);
        });

        document.addEventListener('click', (e) => {
          if (!profileButton.contains(e.target) && !profileDropdown.contains(e.target)) {
            profileDropdown.style.display = 'none';
            profileButton.setAttribute('aria-expanded', 'false');
          }
        });
      }

      // Logout handler
      if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
          await api.post('/api/auth/logout');
          window.location.href = '/login.html';
        });
      }
    } catch (err) {
      console.error('Auth check error:', err);
      window.location.href = '/login.html';
    }
  }

  // -------------------------------------------------------------
  // 2. STEP 1: FETCH DATASETS & SELECTION
  // -------------------------------------------------------------
  async function loadDatasets() {
    const loadingSpinner = document.getElementById('dataset-loading-spinner');
    const emptyState = document.getElementById('dataset-empty-state');
    const tableContainer = document.getElementById('datasets-table-container');
    const tbody = document.getElementById('datasets-tbody');
    const btnToStep2 = document.getElementById('btn-to-step-2');

    try {
      const data = await api.get('/api/datasets');
      if (loadingSpinner) loadingSpinner.style.display = 'none';

      if (!data.success || !data.datasets || data.datasets.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        if (tableContainer) tableContainer.style.display = 'none';
        return;
      }

      availableDatasets = data.datasets;
      if (emptyState) emptyState.style.display = 'none';
      if (tableContainer) tableContainer.style.display = 'block';

      tbody.innerHTML = '';
      availableDatasets.forEach((ds, index) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        const formattedSize = ds.file_size > 1024 * 1024
          ? (ds.file_size / (1024 * 1024)).toFixed(2) + ' MB'
          : (ds.file_size / 1024).toFixed(1) + ' KB';
        const uploadDate = new Date(ds.uploaded_at).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        tr.innerHTML = `
          <td>
            <input type="radio" name="selected_dataset" value="${ds.id}" id="ds_radio_${ds.id}" ${index === 0 ? 'checked' : ''}>
          </td>
          <td style="font-weight: 600; color: var(--color-primary);">
            <label for="ds_radio_${ds.id}" style="cursor: pointer;">${ds.file_name}</label>
          </td>
          <td><span class="badge badge-teal">${ds.file_type.toUpperCase()}</span></td>
          <td style="color: var(--color-text-muted); font-family: var(--font-family-mono); font-size: 0.8rem;">${formattedSize}</td>
          <td style="color: var(--color-text-muted);">${uploadDate}</td>
        `;

        tr.addEventListener('click', (e) => {
          if (e.target.tagName !== 'INPUT') {
            const radio = tr.querySelector('input[type="radio"]');
            radio.checked = true;
          }
          onDatasetRadioChange(ds);
        });

        tbody.appendChild(tr);
      });

      // Default select the first dataset
      if (availableDatasets.length > 0) {
        onDatasetRadioChange(availableDatasets[0]);
        if (btnToStep2) btnToStep2.disabled = false;
      }
    } catch (err) {
      if (loadingSpinner) loadingSpinner.style.display = 'none';
      showAlert('Could not load ingested datasets: ' + err.message);
    }
  }

  function onDatasetRadioChange(dataset) {
    selectedDataset = dataset;
    const btnToStep2 = document.getElementById('btn-to-step-2');
    if (btnToStep2) btnToStep2.disabled = false;

    const sheetGroup = document.getElementById('excel-sheet-selector-group');
    const sheetSelect = document.getElementById('excel-sheet-select');

    if (dataset.file_type === 'xlsx' || dataset.file_type === 'xls') {
      if (sheetGroup) sheetGroup.style.display = 'block';
      if (sheetSelect) {
        sheetSelect.innerHTML = '<option value="">Default (First Sheet)</option>';
      }
    } else {
      if (sheetGroup) sheetGroup.style.display = 'none';
      activeSheetName = null;
    }
  }

  // -------------------------------------------------------------
  // 3. STEP 2: PROFILE DATASET
  // -------------------------------------------------------------
  const btnToStep2 = document.getElementById('btn-to-step-2');
  if (btnToStep2) {
    btnToStep2.addEventListener('click', async () => {
      if (!selectedDataset) return;

      btnToStep2.disabled = true;
      btnToStep2.textContent = 'Inspecting & Profiling...';
      hideAlert();

      try {
        const sheetSelect = document.getElementById('excel-sheet-select');
        activeSheetName = sheetSelect ? sheetSelect.value : null;

        const res = await api.post('/api/agents/preprocessing/profile', {
          datasetId: selectedDataset.id,
          sheet: activeSheetName || undefined
        });

        if (!res.success) {
          throw new Error(res.message || 'Profiling failed');
        }

        activeProfile = res;
        renderProfileStep(res);
        goToStep(2);
      } catch (err) {
        showAlert('Profiling Error: ' + err.message);
      } finally {
        btnToStep2.disabled = false;
        btnToStep2.innerHTML = 'Inspect & Profile Dataset &rarr;';
      }
    });
  }

  function renderProfileStep(data) {
    const prof = data.profile || {};
    document.getElementById('prof-rows').textContent = (prof.total_rows || 0).toLocaleString();
    document.getElementById('prof-cols').textContent = (prof.total_columns || 0).toLocaleString();
    document.getElementById('prof-dups').textContent = (prof.duplicate_rows || 0).toLocaleString();
    
    const qualityVal = prof.quality_score !== undefined ? prof.quality_score : 100;
    const scoreElem = document.getElementById('prof-score');
    scoreElem.textContent = qualityVal + '/100';
    if (qualityVal >= 80) scoreElem.style.color = 'var(--color-accent)';
    else if (qualityVal >= 50) scoreElem.style.color = 'var(--color-warning)';
    else scoreElem.style.color = 'var(--color-error)';

    // Column table
    const colTbody = document.getElementById('columns-profile-tbody');
    colTbody.innerHTML = '';
    (prof.columns || []).forEach(c => {
      const tr = document.createElement('tr');
      const minMaxStr = (c.min !== undefined && c.max !== undefined)
        ? `${c.min} / ${c.max} (μ: ${c.mean})`
        : '-';
      const missingBadgeClass = c.missing_pct > 20 ? 'badge-error' : (c.missing_pct > 0 ? 'badge-warning' : 'badge-teal');

      tr.innerHTML = `
        <td style="font-weight: 600; color: var(--color-primary);">${c.name}</td>
        <td><code>${c.dtype}</code></td>
        <td>${c.missing_count}</td>
        <td><span class="badge ${missingBadgeClass}" style="font-size: 0.72rem;">${c.missing_pct}%</span></td>
        <td>${c.unique_count}</td>
        <td style="font-size: 0.8rem; color: var(--color-text-muted); font-family: var(--font-family-mono);">${minMaxStr}</td>
      `;
      colTbody.appendChild(tr);
    });

    // Raw sample preview table (first 5 rows)
    const thead = document.getElementById('raw-sample-thead');
    const tbody = document.getElementById('raw-sample-tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const sampleRows = prof.sample_rows || [];
    if (sampleRows.length > 0) {
      const colHeaders = Object.keys(sampleRows[0]);
      const headerTr = document.createElement('tr');
      colHeaders.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        headerTr.appendChild(th);
      });
      thead.appendChild(headerTr);

      sampleRows.forEach(row => {
        const rowTr = document.createElement('tr');
        colHeaders.forEach(h => {
          const td = document.createElement('td');
          td.textContent = row[h] !== null ? row[h] : 'null';
          if (row[h] === null) td.style.color = 'var(--color-text-subtle)';
          rowTr.appendChild(td);
        });
        tbody.appendChild(rowTr);
      });
    }

    // Populate Step 3 selectors
    populateConfigStep(data);
  }

  // -------------------------------------------------------------
  // 4. STEP 3: CONFIGURE PIPELINE
  // -------------------------------------------------------------
  function populateConfigStep(data) {
    const dateSelect = document.getElementById('cfg-date-col');
    const targetSelect = document.getElementById('cfg-target-col');

    dateSelect.innerHTML = '';
    targetSelect.innerHTML = '';

    const cols = data.standardized_columns || (data.profile.columns || []).map(c => c.name);
    const detectedDate = data.detected_date_column;
    const suggestedTarget = data.suggested_target_column;

    cols.forEach(col => {
      // Date option
      const optDate = document.createElement('option');
      optDate.value = col;
      optDate.textContent = col + (col === detectedDate ? ' (Auto)' : '');
      if (col === detectedDate) optDate.selected = true;
      dateSelect.appendChild(optDate);

      // Target option
      const optTarget = document.createElement('option');
      optTarget.value = col;
      optTarget.textContent = col + (col === suggestedTarget ? ' (Suggested)' : '');
      if (col === suggestedTarget) optTarget.selected = true;
      targetSelect.appendChild(optTarget);
    });

    // Pre-fill defaults from recommended_config if provided
    if (data.recommended_config) {
      const rc = data.recommended_config;
      if (rc.frequency) document.getElementById('cfg-frequency').value = rc.frequency;
      if (rc.duplicate_aggregation) document.getElementById('cfg-dup-agg').value = rc.duplicate_aggregation;
      if (rc.outlier_action) document.getElementById('cfg-outlier-action').value = rc.outlier_action;
      if (rc.outlier_method) document.getElementById('cfg-outlier-method').value = rc.outlier_method;
      if (rc.missing_threshold) document.getElementById('cfg-missing-threshold').value = rc.missing_threshold;
    }
  }

  // Step navigation buttons
  document.getElementById('btn-back-to-step-1')?.addEventListener('click', () => goToStep(1));
  document.getElementById('btn-to-step-3')?.addEventListener('click', () => goToStep(3));
  document.getElementById('btn-back-to-step-2')?.addEventListener('click', () => goToStep(2));
  document.getElementById('btn-process-another')?.addEventListener('click', () => {
    goToStep(1);
    loadDatasets();
    loadJobHistory();
  });

  // Submit Preprocessing Job
  const configForm = document.getElementById('preprocessing-config-form');
  if (configForm) {
    configForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedDataset) return;

      const dateCol = document.getElementById('cfg-date-col').value;
      const targetCol = document.getElementById('cfg-target-col').value;
      const freq = document.getElementById('cfg-frequency').value;
      const dupAgg = document.getElementById('cfg-dup-agg').value;
      const outlierAction = document.getElementById('cfg-outlier-action').value;
      const outlierMethod = document.getElementById('cfg-outlier-method').value;
      const missingThreshold = parseFloat(document.getElementById('cfg-missing-threshold').value) || 60;

      const configPayload = {
        date_column: dateCol,
        target_column: targetCol,
        frequency: freq,
        duplicate_aggregation: dupAgg,
        outlier_action: outlierAction,
        outlier_method: outlierMethod,
        missing_threshold: missingThreshold,
        sheet_name: activeSheetName || undefined
      };

      goToStep(4);
      document.getElementById('results-running-state').style.display = 'block';
      document.getElementById('results-completed-state').style.display = 'none';

      try {
        const res = await api.post('/api/agents/preprocessing/run', {
          datasetId: selectedDataset.id,
          config: configPayload
        });

        if (!res.success || !res.jobId) {
          throw new Error(res.message || 'Failed to dispatch preprocessing job.');
        }

        currentJobId = res.jobId;
        startJobPolling(currentJobId);
      } catch (err) {
        document.getElementById('results-running-state').style.display = 'none';
        showAlert('Job Dispatch Failed: ' + err.message);
      }
    });
  }

  // -------------------------------------------------------------
  // 5. STEP 4: POLLING & RESULTS DISPLAY
  // -------------------------------------------------------------
  function startJobPolling(jobId) {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(async () => {
      try {
        const statusRes = await api.get(`/api/agents/preprocessing/jobs/${jobId}`);
        if (!statusRes.success || !statusRes.job) return;

        const job = statusRes.job;
        if (job.status === 'completed') {
          clearInterval(pollingInterval);
          loadJobReport(jobId);
        } else if (job.status === 'failed') {
          clearInterval(pollingInterval);
          document.getElementById('results-running-state').style.display = 'none';
          showAlert(`Preprocessing Job Failed: ${job.error_message || 'An error occurred during pipeline execution.'}`);
        }
      } catch (err) {
        console.warn('Job polling warning:', err);
      }
    }, 1500);
  }

  async function loadJobReport(jobId) {
    try {
      const data = await api.get(`/api/agents/preprocessing/jobs/${jobId}/report`);
      if (!data.success) {
        throw new Error(data.message || 'Could not fetch job report.');
      }

      currentJobId = jobId;
      renderCompletedResults(data);
      loadJobHistory();
    } catch (err) {
      document.getElementById('results-running-state').style.display = 'none';
      showAlert('Failed to load completed report: ' + err.message);
    }
  }

  function renderCompletedResults(data) {
    document.getElementById('results-running-state').style.display = 'none';
    document.getElementById('results-completed-state').style.display = 'block';

    const quality = data.quality || {};
    const readiness = data.readiness || {};
    const dataset = data.dataset || {};
    const auditLog = data.audit_log || [];
    const sampleData = data.sample_cleaned_data || [];

    // Quality Score
    const qBefore = quality.before !== undefined ? quality.before : 0;
    const qAfter = quality.after !== undefined ? quality.after : 100;
    document.getElementById('res-score-after').textContent = qAfter;
    document.getElementById('res-score-before').textContent = `from ${qBefore}`;
    
    const deltaElem = document.getElementById('res-quality-improvement');
    const delta = qAfter - qBefore;
    deltaElem.textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} Pts (${quality.improvement_pct || 0}% Improvement)`;

    // Readiness Score
    const rScore = readiness.score !== undefined ? readiness.score : 0;
    document.getElementById('res-readiness-num').textContent = `${rScore}/100`;
    const rBadge = document.getElementById('res-readiness-badge');
    const rStatus = readiness.overall_status || 'READY';
    rBadge.textContent = rStatus;
    rBadge.className = `score-badge-status status-${rStatus.toLowerCase()}`;

    // Summary Metrics
    document.getElementById('summary-rows').textContent = `${dataset.rows_before || '-'} → ${dataset.rows_after || '-'}`;
    document.getElementById('summary-cols').textContent = `${dataset.columns_before || '-'} → ${dataset.columns_after || '-'}`;
    document.getElementById('summary-freq').textContent = dataset.frequency || 'Regular';
    document.getElementById('summary-target').textContent = dataset.target_column || '-';

    // Readiness Checklist
    const checklistContainer = document.getElementById('readiness-checklist-container');
    checklistContainer.innerHTML = '';
    (readiness.checklist || []).forEach(item => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'readiness-item';
      const iconClass = item.status === 'pass' ? 'icon-pass' : (item.status === 'warn' ? 'icon-warn' : 'icon-fail');
      const iconSymbol = item.status === 'pass' ? '✓' : (item.status === 'warn' ? '!' : '✕');

      itemDiv.innerHTML = `
        <div class="readiness-icon ${iconClass}">${iconSymbol}</div>
        <div class="readiness-body">
          <h4>${item.check} (${item.score}/${item.max_score} pts)</h4>
          <p>${item.reason}</p>
        </div>
      `;
      checklistContainer.appendChild(itemDiv);
    });

    // Chart.js Visualization
    renderTimeSeriesChart(sampleData, dataset.date_column, dataset.target_column);

    // Audit Log Timeline
    const timelineContainer = document.getElementById('audit-timeline-container');
    timelineContainer.innerHTML = '';
    auditLog.forEach(action => {
      const entryDiv = document.createElement('div');
      entryDiv.className = 'audit-entry';
      entryDiv.innerHTML = `
        <div class="audit-marker"></div>
        <div class="audit-card">
          <div class="audit-header">
            <span class="step-chip">${action.step_name}</span>
            <span class="col-chip">${action.column_name}</span>
            <span class="rows-chip">${action.rows_affected} affected</span>
          </div>
          <p class="audit-desc">${action.description}</p>
        </div>
      `;
      timelineContainer.appendChild(entryDiv);
    });

    // Cleaned Data Preview Table
    const previewThead = document.getElementById('cleaned-preview-thead');
    const previewTbody = document.getElementById('cleaned-preview-tbody');
    previewThead.innerHTML = '';
    previewTbody.innerHTML = '';

    if (sampleData.length > 0) {
      const headers = Object.keys(sampleData[0]);
      const trHeader = document.createElement('tr');
      headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        if (h === dataset.date_column || h === dataset.target_column) {
          th.style.color = 'var(--color-accent)';
          th.style.fontWeight = '700';
        }
        trHeader.appendChild(th);
      });
      previewThead.appendChild(trHeader);

      sampleData.forEach(row => {
        const tr = document.createElement('tr');
        headers.forEach(h => {
          const td = document.createElement('td');
          td.textContent = row[h] !== null ? row[h] : '';
          tr.appendChild(td);
        });
        previewTbody.appendChild(tr);
      });
    }

    // Download Button Action
    const btnDownload = document.getElementById('btn-download-cleaned');
    if (btnDownload) {
      btnDownload.onclick = () => {
        window.location.href = `/api/agents/preprocessing/jobs/${data.job.id}/download`;
      };
    }
  }

  // Chart Rendering
  function renderTimeSeriesChart(sampleData, dateCol, targetCol) {
    const canvas = document.getElementById('targetTimeSeriesChart');
    if (!canvas || !sampleData || sampleData.length === 0) return;

    if (chartInstance) {
      chartInstance.destroy();
    }

    const labels = sampleData.map(r => r[dateCol] || '');
    const values = sampleData.map(r => r[targetCol] !== null ? r[targetCol] : null);

    const ctx = canvas.getContext('2d');
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: `Cleaned Target: ${targetCol}`,
          data: values,
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13, 148, 136, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.15,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { font: { family: 'Inter', size: 12 } }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              maxTicksLimit: 12,
              font: { family: 'Inter', size: 11 }
            }
          },
          y: {
            grid: { color: 'rgba(226, 232, 240, 0.6)' },
            ticks: { font: { family: 'Inter', size: 11 } }
          }
        }
      }
    });
  }

  // -------------------------------------------------------------
  // 6. JOB HISTORY
  // -------------------------------------------------------------
  async function loadJobHistory() {
    const tbody = document.getElementById('history-tbody');
    try {
      const data = await api.get('/api/agents/preprocessing/jobs');
      if (!data.success || !data.jobs || data.jobs.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; color: var(--color-text-subtle); padding: 24px;">No preprocessing jobs on record yet.</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = '';
      data.jobs.forEach(j => {
        const tr = document.createElement('tr');
        const shortId = j.id ? j.id.substring(0, 8) + '...' : '-';
        const dateStr = new Date(j.created_at).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        const statusBadge = j.status === 'completed'
          ? '<span class="badge badge-teal">COMPLETED</span>'
          : (j.status === 'failed' ? '<span class="badge badge-error">FAILED</span>' : '<span class="badge badge-navy">RUNNING</span>');

        const rowsInOut = (j.rows_before !== null && j.rows_after !== null)
          ? `${j.rows_before} → ${j.rows_after}`
          : '-';

        const qScore = (j.quality_score_after !== null)
          ? `${j.quality_score_after}/100`
          : '-';

        const rScore = (j.readiness_score !== null)
          ? `<span class="score-badge-status status-ready" style="font-size: 0.72rem; padding: 2px 6px;">${j.readiness_score}/100</span>`
          : '-';

        tr.innerHTML = `
          <td><code>${shortId}</code></td>
          <td style="font-weight: 600; color: var(--color-primary);">${j.source_filename || '-'}</td>
          <td>${j.target_column || '-'}</td>
          <td>${statusBadge}</td>
          <td>${rowsInOut}</td>
          <td>${qScore}</td>
          <td>${rScore}</td>
          <td style="color: var(--color-text-muted); font-size: 0.8rem;">${dateStr}</td>
          <td>
            ${j.status === 'completed' ? `
              <button class="btn-secondary-agent btn-view-report" data-job-id="${j.id}" style="padding: 4px 8px; font-size: 0.75rem;">
                View
              </button>
              <a href="/api/agents/preprocessing/jobs/${j.id}/download" class="btn-secondary-agent" style="padding: 4px 8px; font-size: 0.75rem; text-decoration: none;">
                CSV
              </a>
            ` : '-'}
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Attach view report listeners
      tbody.querySelectorAll('.btn-view-report').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const jId = e.target.getAttribute('data-job-id');
          if (jId) {
            goToStep(4);
            loadJobReport(jId);
          }
        });
      });
    } catch (err) {
      console.warn('Could not load history:', err);
    }
  }

  document.getElementById('btn-refresh-history')?.addEventListener('click', loadJobHistory);

  // Initialize
  initAuth();
  loadDatasets();
  loadJobHistory();
});
