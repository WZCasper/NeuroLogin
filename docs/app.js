function adminApp() {
  const cfg = window.NEUROLOGIN_CONFIG;

  return {
    cfg,
    telegramUser: null,
    loginCode: null,
    loginDeepLink: '',
    _pollTimer: null,

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
      const stored = sessionStorage.getItem('neurologin_tg_user');
      if (stored) {
        try {
          this.telegramUser = JSON.parse(stored);
          this.loadGroups();
        } catch (err) {
          sessionStorage.removeItem('neurologin_tg_user');
        }
      }
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
      this._pollTimer = setInterval(() => this.pollLogin(), 3000);
    },

    cancelLogin() {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      this.loginCode = null;
      this.loginDeepLink = '';
    },

    async pollLogin() {
      if (!this.loginCode) return;
      try {
        const resp = await fetch(this.rawUrl('data/auth_sessions.json'));
        if (!resp.ok) return;
        const sessions = await resp.json();
        const session = sessions[this.loginCode];
        if (session) {
          clearInterval(this._pollTimer);
          this._pollTimer = null;
          this.telegramUser = {
            id: session.telegramUserId,
            firstName: session.firstName,
            username: session.username,
          };
          sessionStorage.setItem('neurologin_tg_user', JSON.stringify(this.telegramUser));
          this.loginCode = null;
          this.showToast('Вход выполнен');
          await this.loadGroups();
        }
      } catch (err) {
        console.error(err);
      }
    },

    logout() {
      sessionStorage.removeItem('neurologin_tg_user');
      this.telegramUser = null;
      this.groups = [];
      this.allGroups = [];
      this.users = [];
      this.selectedGroupId = null;
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
      this.groups = this.allGroups
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
