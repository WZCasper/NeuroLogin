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
    isInTelegram: false,
    telegramUser: null,
    pendingSaveNotice: true,
    debugInfo: '',

    tab: 'users',
    allGroups: [],
    groups: [],
    selectedGroupId: null,
    users: [],
    survey: [],
    triggers: [],
    usersDirty: false,
    loading: false,
    editing: {},
    editBuffer: '',
    toast: '',

    allBases: [],
    currentBaseId: null,
    currentBaseName: '',
    isBaseOwner: true,
    createBaseModal: false,
    attachBaseModal: false,
    newBaseName: '',

    init() {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
      }

      // Keyboard-button-launched Mini Apps (required for sendData, see
      // sendToBotAndClose below) don't get Telegram.WebApp.initDataUnsafe
      // populated — Telegram treats initData and sendData as mutually
      // exclusive. The bot embeds the real identity in the button's URL
      // instead, since it already knows exactly who it's replying to.
      const params = new URLSearchParams(window.location.search);
      const uid = params.get('uid');

      this.debugInfo = JSON.stringify({
        href: window.location.href,
        search: window.location.search,
        uid: uid,
        hasTelegramObject: !!tg,
        hasSendData: !!(tg && typeof tg.sendData === 'function'),
      });

      if (!uid || Number.isNaN(Number(uid))) {
        this.isInTelegram = false;
        return;
      }

      this.isInTelegram = true;
      this.telegramUser = {
        id: Number(uid),
        firstName: params.get('name') || 'Админ',
        username: params.get('username') || undefined,
      };
      this.loadGroups();
    },

    showToast(msg) {
      this.toast = msg;
      setTimeout(() => (this.toast = ''), 2500);
    },

    // ---------------- Data loading (read-only, no auth needed — public repo) ----------------

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
        this.triggers = [];
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
        const groupRecord = this.allGroups.find((g) => g.chatId === this.selectedGroupId);
        this.currentBaseId = (groupRecord && groupRecord.baseId) || null;

        if (this.currentBaseId) {
          const basesObj = await this.fetchJson('data/bases.json', {});
          const base = basesObj[this.currentBaseId];
          this.currentBaseName = base ? base.name : '(база не найдена)';
          this.isBaseOwner = !!base && base.ownerUserId === this.telegramUser.id;
        } else {
          this.currentBaseName = '';
          this.isBaseOwner = true;
        }

        const dataRoot = this.currentBaseId
          ? `data/bases/${this.currentBaseId}`
          : `data/groups/${this.selectedGroupId}`;

        const usersObj = await this.fetchJson(`${dataRoot}/users.json`, {});
        this.users = Object.values(usersObj).sort((a, b) =>
          (b.confirmedAt || '').localeCompare(a.confirmedAt || '')
        );
        this.usersDirty = false;

        let survey = await this.fetchJson(`${dataRoot}/survey.json`, null);
        if (!survey) {
          survey = await this.fetchJson('data/survey.json', []);
        }
        this.survey = survey;

        this.triggers = await this.fetchJson(`${dataRoot}/triggers.json`, []);
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
      if (!this.isBaseOwner) {
        this.showToast('Общую базу может редактировать только её владелец');
        return;
      }
      this.editing[user.userId] = key;
      this.editBuffer = currentValue;
    },

    commitFieldEdit(user, key) {
      user.answers[key].value = this.editBuffer;
      user.updatedAt = new Date().toISOString();
      delete this.editing[user.userId];
      this.usersDirty = true;
    },

    saveUsers() {
      const usersObj = {};
      this.users.forEach((u) => (usersObj[u.userId] = u));
      this.sendToBotAndClose('save_users', usersObj);
    },

    // ---------------- Survey tab ----------------

    get surveyFieldNames() {
      return this.survey.map((step) => step.field).filter(Boolean);
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

    saveSurvey() {
      this.sendToBotAndClose('save_survey', this.survey);
    },

    // ---------------- Triggers tab ----------------

    addTrigger() {
      this.triggers.push({
        id: 'trigger_' + Math.random().toString(36).slice(2, 8),
        keyword: '',
        matchType: 'contains',
        caseSensitive: false,
        response: '',
      });
    },

    removeTrigger(idx) {
      this.triggers.splice(idx, 1);
    },

    saveTriggers() {
      this.sendToBotAndClose('save_triggers', this.triggers);
    },

    // ---------------- Shared bases ----------------

    openCreateBaseModal() {
      this.newBaseName = '';
      this.createBaseModal = true;
    },

    confirmCreateBase() {
      const name = this.newBaseName.trim();
      if (!name) {
        this.showToast('Введите название базы');
        return;
      }
      this.createBaseModal = false;
      this.sendToBotAndClose('create_base', { name });
    },

    async openAttachBaseModal() {
      const basesObj = await this.fetchJson('data/bases.json', {});
      this.allBases = Object.values(basesObj).sort((a, b) => a.name.localeCompare(b.name));
      this.attachBaseModal = true;
    },

    confirmAttachBase(baseId) {
      this.attachBaseModal = false;
      this.sendToBotAndClose('attach_base', { baseId });
    },

    doDetachBase() {
      this.sendToBotAndClose('detach_base', {});
    },

    // ---------------- Handoff to the bot ----------------

    // Telegram only allows a Mini App opened from a keyboard button to call
    // sendData, and only once per session — Telegram closes the app right
    // after. The bot receives the payload as an already-authenticated
    // message (ctx.from.id is trustworthy) and writes + commits it, no
    // GitHub token or separate login involved.
    sendToBotAndClose(action, payload) {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (!tg || typeof tg.sendData !== 'function') {
        this.showToast('Сохранение доступно только внутри Telegram');
        return;
      }
      const data = JSON.stringify({ action, groupChatId: this.selectedGroupId, payload });
      if (data.length > 4000) {
        this.showToast('Слишком большой объём данных для сохранения за раз (лимит Telegram — 4 КБ)');
        return;
      }
      tg.sendData(data);
    },
  };
}
