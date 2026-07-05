function adminApp() {
  const cfg = window.NEUROLOGIN_CONFIG;

  return {
    tab: 'users',
    groups: [],
    selectedGroupId: null,
    users: [],
    survey: [],
    loading: false,
    token: sessionStorage.getItem('neurologin_gh_token') || '',
    tokenInput: '',
    tokenModal: false,
    editing: {}, // { [userId]: fieldKey }
    editBuffer: '',
    toast: '',

    init() {
      this.loadGroups();
    },

    showToast(msg) {
      this.toast = msg;
      setTimeout(() => (this.toast = ''), 2500);
    },

    openTokenModal() {
      this.tokenInput = '';
      this.tokenModal = true;
    },

    saveToken() {
      this.token = this.tokenInput.trim();
      sessionStorage.setItem('neurologin_gh_token', this.token);
      this.tokenModal = false;
      this.showToast('Токен сохранён в этой вкладке');
    },

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
      this.loading = true;
      const groupsObj = await this.fetchJson('data/groups.json', {});
      this.groups = Object.values(groupsObj).sort((a, b) => a.title.localeCompare(b.title));
      if (this.groups.length && !this.selectedGroupId) {
        this.selectedGroupId = this.groups[0].chatId;
      }
      if (this.selectedGroupId) {
        await this.loadGroupData();
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

    async loadData() {
      await this.loadGroups();
    },

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
      if (!this.token) {
        this.showToast('Сначала введите токен доступа');
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
      if (!this.token) {
        this.showToast('Сначала введите токен доступа');
        this.openTokenModal();
        return;
      }
      // Saved as a per-group override so different groups can run different surveys.
      await this.commitFile(
        `data/groups/${this.selectedGroupId}/survey.json`,
        JSON.stringify(this.survey, null, 2),
        `Админ обновил опрос для группы ${this.selectedGroupId}`
      );
    },

    async getFileSha(path) {
      const resp = await fetch(
        `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
      const json = await resp.json();
      return json.sha;
    },

    async commitFile(path, content, message) {
      if (!this.token) {
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
              Authorization: `Bearer ${this.token}`,
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
