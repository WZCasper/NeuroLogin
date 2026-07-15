function adminApp() {
  const cfg = window.NEUROLOGIN_CONFIG;

  const parseIfPossible = (text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  };

  return {
    cfg,
    telegramUser: null,
    ownerMode: false,
    ownerTokenModal: false,
    ownerTokenInput: '',
    loginCode: null,
    loginDeepLink: '',
    loginTimedOut: false,
    lastCheckInfo: '',
    _pollTimer: null,
    _pollAttempts: 0,

    tab: 'users',
    allGroups: [],
    groups: [],
    selectedGroupId: null,
    users: [],
    survey: [],
    loading: false,
    ghToken: sessionStorage.getItem('neurologin_gh_token') || '',
    tokenInput: '',
    tokenModal: false,
    editing: {},
    editBuffer: '',
    toast: '',

    init() {
      // Owner-token login: fully bypasses Telegram, no polling involved.
      const storedOwner = localStorage.getItem('neurologin_owner_mode');
      const storedOwnerToken = sessionStorage.getItem('neurologin_gh_token');
      if (storedOwner === '1' && storedOwnerToken) {
        this.ownerMode = true;
        this.ghToken = storedOwnerToken;
        this.telegramUser = { firstName: 'Владелец репозитория' };
        this.loadGroups();
        return;
      }

      // Highest priority: a code embedded directly in the URL. This is how
      // the bot's "Вернуться на сайт" button works — it opens a brand new
      // page load with the code attached, so it doesn't depend on any
      // storage or tab state surviving the trip to Telegram and back.
      const urlCode = new URLSearchParams(window.location.search).get('code');

      const stored = localStorage.getItem('neurologin_tg_user');
      if (stored && !urlCode) {
        try {
          this.telegramUser = JSON.parse(stored);
          this.loadGroups();
          return;
        } catch (err) {
          localStorage.removeItem('neurologin_tg_user');
        }
      }

      const pendingCode = urlCode || localStorage.getItem('neurologin_pending_code');
      if (pendingCode) {
        this.loginCode = pendingCode;
        this.loginTimedOut = false;
        this.loginDeepLink = `https://t.me/${cfg.botUsername}?start=login_${pendingCode}`;
        this._pollAttempts = 0;
        localStorage.setItem('neurologin_pending_code', pendingCode);
        this.pollLogin();
        this._pollTimer = setInterval(() => this.pollLogin(), 4000);
      }

      // Extra safety net in case the interval itself gets throttled by the
      // OS/browser while the tab is in the background.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.loginCode) {
          this.pollLogin();
        }
      });
    },

    showToast(msg) {
      this.toast = msg;
      setTimeout(() => (this.toast = ''), 2500);
    },

    // ---------------- Telegram login ----------------

    randomCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let out = '';
      for (let i = 0; i < 8; i++) {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    },

    startTelegramLogin() {
      this.loginCode = this.randomCode();
      this.loginDeepLink = `https://t.me/${cfg.botUsername}?start=login_${this.loginCode}`;
      this.loginTimedOut = false;
      this.lastCheckInfo = '';
      this._pollAttempts = 0;
      localStorage.setItem('neurologin_pending_code', this.loginCode);
      this.pollLogin();
      this._pollTimer = setInterval(() => this.pollLogin(), 4000);
    },

    cancelLogin() {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      this.loginCode = null;
      this.loginDeepLink = '';
      this.loginTimedOut = false;
      this.lastCheckInfo = '';
      localStorage.removeItem('neurologin_pending_code');
      this.clearCodeFromUrl();
    },

    retryLogin() {
      this.cancelLogin();
      this.startTelegramLogin();
    },

    clearCodeFromUrl() {
      if (window.location.search.includes('code=')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.pathname + url.hash);
      }
    },

    // Checks login status via two independent sources in parallel:
    // - api.github.com always reflects the latest commit, but is capped at
    //   60 requests/hour for anonymous callers (a shared limit that can be
    //   affected by others behind the same carrier-grade NAT on mobile).
    // - raw.githubusercontent.com has no such request cap, but caches file
    //   contents at the CDN edge for up to 5 minutes and does not reliably
    //   bust that cache via query strings.
    // Neither is perfect alone; together they cover each other's weak spot.
    async pollLogin() {
      if (!this.loginCode) return;
      this._pollAttempts += 1;
      const MAX_ATTEMPTS = 45; // ~3 minutes at 4s intervals
      const diagnostics = [];

      const results = await Promise.allSettled([
        fetch(
          `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/data/auth_sessions.json?ref=${cfg.branch}`,
          { headers: { Accept: 'application/vnd.github.raw+json' } }
        ).then((r) => {
          if (!r.ok) {
            diagnostics.push(`API: ошибка ${r.status}`);
            return null;
          }
          return r.text();
        }),
        fetch(this.rawUrl('data/auth_sessions.json')).then((r) => {
          if (!r.ok) {
            diagnostics.push(`CDN: ошибка ${r.status}`);
            return null;
          }
          return r.text();
        }),
      ]);

      const labels = ['API', 'CDN'];
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          diagnostics.push(`${labels[i]}: сеть недоступна (${result.reason && result.reason.message})`);
        }
      });

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const sessions = parseIfPossible(result.value);
        if (!sessions) {
          diagnostics.push('Ответ пришёл, но не прочитался как данные');
          continue;
        }
        const session = sessions[this.loginCode];
        if (session) {
          clearInterval(this._pollTimer);
          this._pollTimer = null;
          this.telegramUser = {
            id: session.telegramUserId,
            firstName: session.firstName,
            username: session.username,
          };
          localStorage.setItem('neurologin_tg_user', JSON.stringify(this.telegramUser));
          localStorage.removeItem('neurologin_pending_code');
          this.clearCodeFromUrl();
          this.loginCode = null;
          this.showToast('Вход выполнен');
          await this.loadGroups();
          return;
        }
      }

      const time = new Date().toLocaleTimeString('ru-RU');
      this.lastCheckInfo = diagnostics.length
        ? `${time} — ${diagnostics.join('; ')}`
        : `${time} — проверено, код пока не подтверждён (попытка ${this._pollAttempts} из ${MAX_ATTEMPTS})`;

      if (this._pollAttempts >= MAX_ATTEMPTS) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
        this.loginCode = null;
        localStorage.removeItem('neurologin_pending_code');
        this.clearCodeFromUrl();
        this.loginTimedOut = true;
      }
    },

    logout() {
      localStorage.removeItem('neurologin_tg_user');
      localStorage.removeItem('neurologin_pending_code');
      localStorage.removeItem('neurologin_owner_mode');
      this.telegramUser = null;
      this.ownerMode = false;
      this.groups = [];
      this.allGroups = [];
      this.users = [];
      this.selectedGroupId = null;
    },

    openOwnerTokenModal() {
      this.ownerTokenInput = '';
      this.ownerTokenModal = true;
    },

    loginWithOwnerToken() {
      const token = this.ownerTokenInput.trim();
      if (!token) {
        this.showToast('Введите токен');
        return;
      }
      this.ghToken = token;
      sessionStorage.setItem('neurologin_gh_token', token);
      this.ownerMode = true;
      localStorage.setItem('neurologin_owner_mode', '1');
      this.telegramUser = { firstName: 'Владелец репозитория' };
      this.ownerTokenModal = false;
      this.showToast('Вход выполнен');
      this.loadGroups();
    },

    // ---------------- Data loading ----------------

    rawUrl(relativePath) {
      return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${relativePath}?t=${Date.now()}`;
    },

    async fetchJson(relativePath, fallback) {
      try {
        const resp = await fetch(this.rawUrl(relativePath));
        if (!resp.ok) return fallback;
        return await resp.json();
      } catch (err) {
        console.error(err);
        return fallback;
      }
    },

    async loadGroups() {
      if (!this.telegramUser) return;
      this.loading = true;
      const groupsObj = await this.fetchJson('data/groups.json', {});
      this.allGroups = Object.values(groupsObj);
      this.groups = this.ownerMode
        ? [...this.allGroups].sort((a, b) => a.title.localeCompare(b.title))
        : this.allGroups
            .filter((g) => g.addedByUserId === this.telegramUser.id)
            .sort((a, b) => a.title.localeCompare(b.title));

      if (this.groups.length && !this.groups.some((g) => g.chatId === this.selectedGroupId)) {
        this.selectedGroupId = this.groups[0].chatId;
      }
      if (this.selectedGroupId) {
        await this.loadGroupData();
      } else {
        this.users = [];
        this.survey = [];
      }
      this.loading = false;
    },

    async selectGroup(chatId) {
      this.selectedGroupId = Number(chatId);
      await this.loadGroupData();
    },

    async loadGroupData() {
      if (!this.selectedGroupId) return;
      this.loading = true;
      try {
        const usersObj = await this.fetchJson(
          `data/groups/${this.selectedGroupId}/users.json`,
          {}
        );
        this.users = Object.values(usersObj).sort((a, b) =>
          (b.confirmedAt || '').localeCompare(a.confirmedAt || '')
        );

        let survey = await this.fetchJson(
          `data/groups/${this.selectedGroupId}/survey.json`,
          null
        );
        if (!survey) {
          survey = await this.fetchJson('data/survey.json', []);
        }
        this.survey = survey;
      } finally {
        this.loading = false;
      }
    },

    // ---------------- Users tab ----------------

    fieldValue(user, fieldName) {
      const entry = Object.values(user.answers || {}).find((a) => a.field === fieldName);
      return entry ? entry.value : '';
    },

    initials(user) {
      const name = this.fieldValue(user, 'Имя') || String(user.userId);
      return name.slice(0, 2).toUpperCase();
    },

    copyUser(user) {
      const lines = Object.values(user.answers || {}).map((a) => `${a.field}: ${a.value}`);
      const text = lines.join('\n');
      navigator.clipboard.writeText(text).then(
        () => this.showToast('Данные скопированы в буфер обмена'),
        () => this.showToast('Не удалось скопировать')
      );
    },

    startEdit(user, key, currentValue) {
      if (!this.ghToken) {
        this.showToast('Нужен токен для сохранения правок');
        this.openTokenModal();
        return;
      }
      this.editing[user.userId] = key;
      this.editBuffer = currentValue;
    },

    async saveField(user, key) {
      user.answers[key].value = this.editBuffer;
      user.updatedAt = new Date().toISOString();
      delete this.editing[user.userId];

      const usersObj = {};
      this.users.forEach((u) => (usersObj[u.userId] = u));

      await this.commitFile(
        `data/groups/${this.selectedGroupId}/users.json`,
        JSON.stringify(usersObj, null, 2),
        `Админ обновил данные пользователя ${user.userId} (группа ${this.selectedGroupId})`
      );
    },

    // ---------------- Survey tab ----------------

    addStep() {
      this.survey.push({
        id: 'new_step_' + Math.random().toString(36).slice(2, 7),
        field: 'Новое поле',
        question: 'Текст вопроса',
        type: 'text',
        next: '',
        branches: {},
      });
    },

    removeStep(idx) {
      this.survey.splice(idx, 1);
    },

    branchesToText(branches) {
      if (!branches) return '';
      return Object.entries(branches)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    },

    textToBranches(text) {
      const result = {};
      text
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .forEach((pair) => {
          const [k, v] = pair.split('=').map((s) => s.trim());
          if (k && v) result[k] = v;
        });
      return result;
    },

    async saveSurvey() {
      if (!this.ghToken) {
        this.showToast('Нужен токен для сохранения правок');
        this.openTokenModal();
        return;
      }
      await this.commitFile(
        `data/groups/${this.selectedGroupId}/survey.json`,
        JSON.stringify(this.survey, null, 2),
        `Админ обновил опрос для группы ${this.selectedGroupId}`
      );
    },

    // ---------------- GitHub write token (separate from Telegram login) ----------------

    openTokenModal() {
      this.tokenInput = '';
      this.tokenModal = true;
    },

    saveToken() {
      this.ghToken = this.tokenInput.trim();
      sessionStorage.setItem('neurologin_gh_token', this.ghToken);
      this.tokenModal = false;
      this.showToast('Токен сохранён в этой вкладке');
    },

    async getFileSha(path) {
      const resp = await fetch(
        `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`,
        { headers: { Authorization: `Bearer ${this.ghToken}` } }
      );
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
      const json = await resp.json();
      return json.sha;
    },

    async commitFile(path, content, message) {
      if (!this.ghToken) {
        this.showToast('Нет токена доступа');
        return;
      }
      try {
        const sha = await this.getFileSha(path);
        const body = {
          message,
          content: btoa(unescape(encodeURIComponent(content))),
          branch: cfg.branch,
        };
        if (sha) body.sha = sha;

        const resp = await fetch(
          `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${this.ghToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          }
        );
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(errText);
        }
        this.showToast('Сохранено в репозитории');
      } catch (err) {
        console.error(err);
        this.showToast('Ошибка сохранения. Проверь токен и права доступа.');
      }
    },
  };
}
