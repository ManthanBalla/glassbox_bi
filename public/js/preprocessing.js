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
  const profileCache = new Map();
  const profileRequests = new Map();
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

  function renderProcessingStage(stage) {
    const order = ['loading', 'profiling', 'cleaning', 'validating', 'reporting'];
    const current = stage === 'complete' ? order.length : Math.max(0, order.indexOf(stage));
    document.querySelectorAll('#processing-steps li').forEach((item, index) => {
      item.classList.toggle('done', index < current);
      item.classList.toggle('current', index === current);
    });
  }

  function showProcessingError(error) {
    const technical = String(error || 'Unknown processing error');
    const targetProblem = /target|numeric/i.test(technical);
    const dateProblem = /date|timestamp/i.test(technical);
    const reason = targetProblem ? 'The selected target has no usable numeric values or could not be processed.' : dateProblem ? 'The selected date column contains invalid or incompatible dates.' : 'The dataset could not be processed with the current settings.';
    const fix = targetProblem ? 'Choose another target column or correct its values.' : dateProblem ? 'Check the date column and frequency, then try again.' : 'Review the selected columns and file, then try again.';
    alertBanner.replaceChildren();
    const heading = document.createElement('strong'); heading.textContent = 'Unable to process this dataset.';
    const body = document.createElement('p'); body.textContent = `${reason} ${fix}`;
    const details = document.createElement('details'); details.innerHTML = '<summary>Technical details</summary>';
    const technicalText = document.createElement('pre'); technicalText.textContent = technical;
    details.appendChild(technicalText);
    alertBanner.append(heading, body, details);
    alertBanner.className = 'alert alert-error'; alertBanner.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
            <label for="ds_radio_${ds.id}" style="cursor: pointer;"></label>
            <small class="dataset-counts" data-dataset-id="${ds.id}">Rows and columns loading...</small>
          </td>
          <td><span class="badge badge-teal">${ds.file_type.toUpperCase()}</span></td>
          <td style="color: var(--color-text-muted); font-family: var(--font-family-mono); font-size: 0.8rem;">${formattedSize}</td>
          <td style="color: var(--color-text-muted);">${uploadDate}</td>
        `;
        tr.querySelector('label').textContent = ds.file_name;

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
    previewDataset(dataset, null).catch(err => {
      const label = document.querySelector(`.dataset-counts[data-dataset-id="${dataset.id}"]`);
      if (label) label.textContent = 'Counts available after inspection';
      console.warn('Dataset preview:', err);
    });
  }

  async function previewDataset(dataset, sheet) {
    const key = `${dataset.id}:${sheet || ''}`;
    if (profileCache.has(key)) return profileCache.get(key);
    if (profileRequests.has(key)) return profileRequests.get(key);
    const request = api.post('/api/agents/preprocessing/profile', { datasetId: dataset.id, sheet: sheet || undefined });
    profileRequests.set(key, request);
    try {
      const result = await request;
      if (!result.success) throw new Error(result.message || 'Could not inspect dataset');
      profileCache.set(key, result);
      const label = document.querySelector(`.dataset-counts[data-dataset-id="${dataset.id}"]`);
      if (label) label.textContent = `${result.profile.total_rows.toLocaleString()} rows · ${result.profile.total_columns.toLocaleString()} columns`;
      if (selectedDataset?.id === dataset.id && !sheet && result.sheets?.length) {
        const sheetSelect = document.getElementById('excel-sheet-select');
        sheetSelect.replaceChildren();
        result.sheets.forEach(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; sheetSelect.appendChild(option); });
        activeSheetName = sheetSelect.value;
        profileCache.set(`${dataset.id}:${activeSheetName}`, result);
      }
      return result;
    } finally {
      profileRequests.delete(key);
    }
  }

  document.getElementById('excel-sheet-select')?.addEventListener('change', async event => {
    if (!selectedDataset) return;
    activeSheetName = event.target.value;
    try { await previewDataset(selectedDataset, activeSheetName); }
    catch (err) { showAlert('Could not inspect sheet: ' + err.message); }
  });

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

        const res = await previewDataset(selectedDataset, activeSheetName);

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
        btnToStep2.innerHTML = 'Continue &rarr;';
      }
    });
  }

  function renderProfileStep(data) {
    const prof = data.profile || {};
    document.getElementById('prof-rows').textContent = (prof.total_rows || 0).toLocaleString();
    document.getElementById('prof-cols').textContent = (prof.total_columns || 0).toLocaleString();
    document.getElementById('prof-missing').textContent = `${prof.quality_breakdown?.missing_pct ?? 0}%`;
    document.getElementById('prof-dups').textContent = (prof.duplicate_rows || 0).toLocaleString();
    
    const qualityVal = prof.quality_score !== undefined ? prof.quality_score : 100;
    const scoreElem = document.getElementById('prof-score');
    scoreElem.textContent = qualityVal + '/100';
    if (qualityVal >= 80) scoreElem.style.color = 'var(--color-accent)';
    else if (qualityVal >= 50) scoreElem.style.color = 'var(--color-warning)';
    else scoreElem.style.color = 'var(--color-error)';

    const roles = data.role_analysis || {};
    const roleCards = document.getElementById('detected-roles');
    roleCards.replaceChildren();
    [['Date', roles.date_candidates?.[0]], ['Target', roles.target_candidates?.[0]]].forEach(([label, candidate]) => {
      const card = document.createElement('div');
      card.className = 'role-card';
      const confidence = candidate?.confidence ?? 0;
      const level = confidence >= 75 ? 'High confidence' : confidence >= 50 ? 'Review suggested' : 'Review recommended';
      const title = document.createElement('strong');
      title.textContent = label;
      const value = document.createElement('div');
      value.textContent = candidate?.column || 'No clear candidate';
      const detail = document.createElement('small');
      detail.textContent = `${confidence}% · ${level}`;
      const why = document.createElement('details');
      why.innerHTML = '<summary>Why?</summary>';
      const whyText = document.createElement('p');
      whyText.textContent = (candidate?.reasons || ['No strong evidence found']).join(' · ');
      why.appendChild(whyText);
      card.append(title, value, detail, why);
      roleCards.appendChild(card);
    });
    const dimensionBox = document.getElementById('detected-dimensions');
    dimensionBox.replaceChildren();
    (roles.business_dimensions || []).forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'dimension-chip';
      chip.textContent = `${item.column} · ${item.confidence}%`;
      chip.title = (item.reasons || []).join(', ');
      dimensionBox.appendChild(chip);
    });
    if (!dimensionBox.children.length) dimensionBox.textContent = 'None detected';

    // Column table
    const colTbody = document.getElementById('columns-profile-tbody');
    colTbody.innerHTML = '';
    (prof.columns || []).forEach(c => {
      const tr = document.createElement('tr');
      const minMaxStr = (c.min !== undefined && c.max !== undefined)
        ? `${c.min} / ${c.max} (μ: ${c.mean})`
        : '-';
      const missingBadgeClass = c.missing_pct > 20 ? 'badge-error' : (c.missing_pct > 0 ? 'badge-warning' : 'badge-teal');

      const role = c.name === data.detected_date_column ? 'Date candidate' : c.name === data.suggested_target_column ? 'Target candidate' : (roles.business_dimensions || []).some(d => d.column === c.name) ? 'Dimension' : 'Feature';
      tr.innerHTML = `
        <td style="font-weight: 600; color: var(--color-primary);">${c.name}</td>
        <td><code>${c.dtype}</code></td>
        <td><span class="badge ${missingBadgeClass}" style="font-size: 0.72rem;">${c.missing_pct}%</span></td>
        <td>${role}</td>
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
    if (!detectedDate) {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a date column'; placeholder.selected = true; placeholder.disabled = true; dateSelect.appendChild(placeholder);
    }
    if (!suggestedTarget) {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a target column'; placeholder.selected = true; placeholder.disabled = true; targetSelect.appendChild(placeholder);
    }

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
      if (rc.imputation_strategy) document.getElementById('cfg-imputation-strategy').value = rc.imputation_strategy;
      document.getElementById('recommendation-summary').textContent = `Date: ${data.detected_date_column || 'review needed'} · Target: ${data.suggested_target_column || 'review needed'} · Frequency: auto · Aggregation: ${rc.duplicate_aggregation} · Missing: automatic · Outliers: flag`;
      document.getElementById('frequency-status').textContent = 'Frequency will be inferred from the date sequence';
      document.getElementById('aggregation-status').textContent = `Recommended for ${rc.target_column}`;
    }
  }

  document.getElementById('cfg-imputation-strategy')?.addEventListener('change', event => {
    document.getElementById('imputation-status').textContent = `${event.target.value === 'forward_fill' ? 'Use latest observed target' : 'Interpolate target'} · Numeric: median · text: mode`;
  });

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
      const imputationStrategy = document.getElementById('cfg-imputation-strategy').value;

      const configPayload = {
        date_column: dateCol,
        target_column: targetCol,
        frequency: freq,
        duplicate_aggregation: dupAgg,
        outlier_action: outlierAction,
        outlier_method: outlierMethod,
        missing_threshold: missingThreshold,
        imputation_strategy: imputationStrategy,
        sheet_name: activeSheetName || undefined
      };

      goToStep(4);
      renderProcessingStage('loading');
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
        showProcessingError(err.message);
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
        renderProcessingStage(job.progress_stage || 'loading');
        if (job.status === 'completed') {
          clearInterval(pollingInterval);
          loadJobReport(jobId);
        } else if (job.status === 'failed') {
          clearInterval(pollingInterval);
          document.getElementById('results-running-state').style.display = 'none';
          showProcessingError(job.error_message);
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

    const forecastability = data.forecastability || {};
    const confidence = data.processing_confidence || {};
    const health = data.time_health || {};
    const comparison = data.comparison || {};
    document.getElementById('res-forecastability').textContent = `${forecastability.score ?? '-'} / 100`;
    document.getElementById('res-forecastability-detail').textContent = `${forecastability.trend || 'Unknown'} trend · ${forecastability.seasonality || 'Unknown'} seasonality`;
    document.getElementById('res-confidence').textContent = confidence.level || 'Unknown';
    document.getElementById('res-confidence-detail').textContent = (confidence.reasons || []).join(' · ');
    const qualityDimensions = document.getElementById('quality-dimensions');
    qualityDimensions.replaceChildren();
    Object.entries(data.quality_dimensions || {}).forEach(([name, score]) => {
      const row = document.createElement('div'); row.className = 'quality-dimension';
      const label = document.createElement('span'); label.textContent = `${name[0].toUpperCase()}${name.slice(1)}  ${score}/100`;
      const bar = document.createElement('progress'); bar.max = 100; bar.value = score;
      row.append(label, bar); qualityDimensions.appendChild(row);
    });
    const forecastStatus = document.getElementById('forecast-status');
    forecastStatus.textContent = rStatus === 'READY' ? 'Ready for forecasting' : rStatus === 'WARN' ? 'Forecasting needs review' : 'Not ready for forecasting';
    forecastStatus.className = `forecast-status forecast-status-${rStatus.toLowerCase()}`;
    const compareBox = document.getElementById('comparison-grid');
    compareBox.replaceChildren();
    [['Rows', comparison.rows], ['Missing values', comparison.missing_values], ['Duplicates', comparison.duplicates], ['Invalid dates', comparison.invalid_dates]].forEach(([label, values]) => {
      const item = document.createElement('div');
      item.className = 'comparison-item';
      item.textContent = `${label}: ${values?.before ?? '-'} → ${values?.after ?? '-'}`;
      compareBox.appendChild(item);
    });
    const outlierItem = document.createElement('div');
    outlierItem.className = 'comparison-item';
    outlierItem.textContent = `Outliers: ${comparison.outliers?.detected ?? 0} detected · ${comparison.outliers?.flagged ?? 0} flagged, values retained`;
    compareBox.appendChild(outlierItem);
    const outlierBody = document.getElementById('outlier-details');
    outlierBody.replaceChildren();
    (data.outlier_events || []).slice(0, 100).forEach(event => {
      const row = document.createElement('tr');
      [event.date, event.value, (event.expected_range || []).join(' – '), event.severity, event.action].forEach(value => {
        const cell = document.createElement('td'); cell.textContent = value ?? '-'; row.appendChild(cell);
      });
      outlierBody.appendChild(row);
    });
    if (!outlierBody.children.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'No unusual target values detected.'; row.appendChild(cell); outlierBody.appendChild(row);
    }
    const healthBox = document.getElementById('health-grid');
    healthBox.replaceChildren();
    [`${health.invalid_dates ?? 0} invalid dates`, `${health.duplicate_dates ?? 0} duplicate dates`, `${health.missing_periods ?? 0} periods filled`, `Frequency: ${dataset.frequency || '-'}`, health.target_constant ? 'Target is constant' : 'Target varies', health.sufficient_history ? 'Sufficient history' : 'Short history'].forEach(value => {
      const item = document.createElement('span'); item.className = 'insight-chip'; item.textContent = value; healthBox.appendChild(item);
    });
    document.getElementById('coverage-details').textContent = `${health.date_start || '-'} → ${health.date_end || '-'} · Expected: ${health.expected_observations ?? '-'} · Observed: ${health.observed_observations ?? '-'} · Largest gap: ${health.largest_gap ?? 0} periods · Longest continuous run: ${health.longest_continuous_run ?? 0}`;
    const forecastBox = document.getElementById('forecastability-grid');
    forecastBox.replaceChildren();
    [`Trend: ${forecastability.trend || '-'}`, `Seasonality: ${forecastability.seasonality || '-'}`, `Variation: ${forecastability.variation || '-'}`, `History: ${forecastability.history ?? '-'} rows`, `Autocorrelation: ${forecastability.autocorrelation || '-'}`].forEach(value => {
      const item = document.createElement('span'); item.className = 'insight-chip'; item.textContent = value; forecastBox.appendChild(item);
    });
    document.getElementById('forecastability-details').textContent = JSON.stringify(forecastability.details || {}, null, 2);
    document.getElementById('quality-calculation').textContent = JSON.stringify(data.quality_breakdown || {}, null, 2);
    const summaryBox = document.getElementById('processing-summary');
    summaryBox.replaceChildren();
    [...new Set(auditLog.map(action => action.step_name))].filter(Boolean).slice(0, 6).forEach(name => {
      const item = document.createElement('span'); item.className = 'insight-chip'; item.textContent = `✓ ${name.replaceAll('_', ' ').toLowerCase()}`; summaryBox.appendChild(item);
    });
    document.getElementById('btn-download-report').href = `/api/agents/preprocessing/jobs/${data.job.id}/report/download`;
    document.getElementById('btn-view-full-dataset').href = `/api/agents/preprocessing/jobs/${data.job.id}/download`;
    if (dataset.id) document.getElementById('btn-continue-forecasting').href = `/agents/forecasting.html?dataset=${encodeURIComponent(dataset.id)}`;

    // Chart.js Visualization
    renderTimeSeriesChart(data.chart_cleaned?.length ? data.chart_cleaned : sampleData, dataset.date_column, dataset.target_column, data.raw_chart || [], data.time_health?.missing_dates || [], data.outlier_events || []);

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
            <span class="step-chip"></span>
            <span class="col-chip"></span>
            <span class="rows-chip"></span>
          </div>
          <p class="audit-desc"></p>
          <small class="audit-meta"></small>
        </div>
      `;
      entryDiv.querySelector('.step-chip').textContent = action.step_name || '-';
      entryDiv.querySelector('.col-chip').textContent = action.column_name || '-';
      entryDiv.querySelector('.rows-chip').textContent = `${action.rows_affected ?? 0} affected`;
      entryDiv.querySelector('.audit-desc').textContent = action.description || '';
      entryDiv.querySelector('.audit-meta').textContent = `Method: ${action.method || '-'} · Reason: ${action.reason || action.description || '-'}${action.before !== null && action.before !== undefined ? ` · Before: ${action.before}` : ''}${action.after !== null && action.after !== undefined ? ` · After: ${action.after}` : ''}`;
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

      sampleData.slice(0, 20).forEach(row => {
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
  function renderTimeSeriesChart(sampleData, dateCol, targetCol, rawChart = [], missingDates = [], outlierEvents = []) {
    const canvas = document.getElementById('targetTimeSeriesChart');
    if (!canvas || !sampleData || sampleData.length === 0) return;

    if (chartInstance) {
      chartInstance.destroy();
    }

    const labels = sampleData.map(r => r.date || r[dateCol] || '');
    const values = sampleData.map(r => r.value ?? r[targetCol] ?? null);
    const rawByDate = new Map(rawChart.map(point => [String(point.date).slice(0, 10), point.value]));
    const rawValues = labels.map(label => rawByDate.get(String(label).slice(0, 10)) ?? null);
    const missingSet = new Set(missingDates);
    const outlierSet = new Set(outlierEvents.map(point => String(point.date).slice(0, 10)));
    const filledValues = labels.map((label, index) => missingSet.has(String(label).slice(0, 10)) ? values[index] : null);
    const outlierValues = labels.map((label, index) => outlierSet.has(String(label).slice(0, 10)) ? values[index] : null);

    const ctx = canvas.getContext('2d');
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{ label: 'Raw target', data: rawValues, borderColor: '#94a3b8', borderWidth: 1.5, pointRadius: 1, tension: 0.1, fill: false }, {
          label: `Cleaned Target: ${targetCol}`,
          data: values,
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13, 148, 136, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.15,
          fill: true
        }, { label: 'Filled periods', data: filledValues, showLine: false, pointRadius: 4, backgroundColor: '#0284c7' }, { label: 'Flagged outliers', data: outlierValues, showLine: false, pointRadius: 4, backgroundColor: '#d97706' }]
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
