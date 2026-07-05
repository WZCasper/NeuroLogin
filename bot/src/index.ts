import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  loadUsers,
  saveUsers,
  loadSessions,
  saveSessions,
  loadSurvey,
  saveMediaFile,
  registerGroup,
  getGroup,
} from './lib/storage';
import { commitDataChanges } from './lib/git';
import { logToGroup } from './lib/notify';
import { getStep, getFirstStep, resolveNextStepId } from './lib/surveyEngine';
import { UserSession, UserRecord } from './lib/types';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set');
}

const bot = new Telegraf(BOT_TOKEN);
let botUsername = '';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function deepLink(groupChatId: number): string {
  return `https://t.me/${botUsername}?start=${groupChatId}`;
}

// ---------------------------------------------------------------------------
// Group admission: the bot can be added to any group, but only by an admin
// of that group. If a non-admin adds it, the bot leaves immediately.
// ---------------------------------------------------------------------------

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const justAdded =
    (oldStatus === 'left' || oldStatus === 'kicked') &&
    (newStatus === 'member' || newStatus === 'administrator');

  if (!justAdded) return;

  const adder = update.from;

  try {
    const member = await ctx.telegram.getChatMember(chat.id, adder.id);
    const isAdmin = member.status === 'administrator' || member.status === 'creator';

    if (!isAdmin) {
      await ctx.telegram.sendMessage(
        chat.id,
        'Добавлять этого бота может только администратор группы. Покидаю чат.'
      );
      await ctx.telegram.leaveChat(chat.id);
      return;
    }

    registerGroup({
      chatId: chat.id,
      title: chat.title,
      addedByUserId: adder.id,
      addedByUsername: adder.username,
      addedAt: new Date().toISOString(),
    });
    await commitDataChanges(`Бот добавлен в группу ${chat.id}`);

    await ctx.telegram.sendMessage(
      chat.id,
      'Бот подключён. Новые участники смогут пройти короткий опрос в личных сообщениях со мной, либо запустите его командой /start прямо здесь.'
    );
  } catch (err) {
    console.error('Failed to process my_chat_member update:', err);
  }
});

// ---------------------------------------------------------------------------
// Greeting new members with a deep link to start the private survey
// ---------------------------------------------------------------------------

bot.on(message('new_chat_members'), async (ctx) => {
  const chat = ctx.chat;
  const group = getGroup(chat.id);
  if (!group) return; // unknown/unauthorized group, ignore

  const newcomers = ctx.message.new_chat_members.filter((m) => !m.is_bot);
  if (newcomers.length === 0) return;

  for (const user of newcomers) {
    const mention = user.username ? `@${user.username}` : user.first_name;
    await ctx.reply(
      `Добро пожаловать, ${escapeHtml(mention)}! Чтобы получить доступ, пройди короткий опрос в личных сообщениях с ботом.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.url('Пройти опрос', deepLink(chat.id)),
        ]),
      }
    );
  }
});

// ---------------------------------------------------------------------------
// /start — three contexts: inside a group, or in DM with/without payload
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const group = getGroup(ctx.chat.id);
    if (!group) {
      await ctx.reply('Эта группа ещё не зарегистрирована. Переустановите бота как администратор группы.');
      return;
    }
    await ctx.reply(
      'Нажми кнопку ниже, чтобы пройти опрос в личных сообщениях.',
      Markup.inlineKeyboard([Markup.button.url('Пройти опрос', deepLink(ctx.chat.id))])
    );
    return;
  }

  // Private chat.
  const payload = ctx.startPayload;
  const groupChatId = payload ? Number(payload) : NaN;

  if (!payload || Number.isNaN(groupChatId) || !getGroup(groupChatId)) {
    await ctx.reply(
      'Чтобы пройти опрос, открой этого бота по ссылке из своей группы (команда /start в группе покажет кнопку).'
    );
    return;
  }

  const userId = ctx.from.id;
  const survey = loadSurvey(groupChatId);
  const first = getFirstStep(survey);
  if (!first) {
    await ctx.reply('Опрос для этой группы пока не настроен.');
    return;
  }

  const session: UserSession = {
    privateChatId: ctx.chat.id,
    groupChatId,
    userId,
    username: ctx.from.username,
    currentStepId: first.id,
    answers: {},
    awaitingConfirm: false,
    startedAt: new Date().toISOString(),
  };
  const sessions = loadSessions();
  sessions[String(userId)] = session;
  saveSessions(sessions);

  await ctx.reply('Начинаем короткий опрос.');
  await ctx.reply(first.question + (first.optional ? '\n\n(необязательный вопрос — можно отправить /skip)' : ''));
});

// ---------------------------------------------------------------------------
// Survey flow (private chat only)
// ---------------------------------------------------------------------------

async function askStep(ctx: Context, groupChatId: number, stepId: string): Promise<void> {
  const survey = loadSurvey(groupChatId);
  const step = getStep(survey, stepId);
  if (!step) {
    await sendConfirmSummary(ctx);
    return;
  }
  const suffix = step.optional ? '\n\n(необязательный вопрос — можно отправить /skip)' : '';
  await ctx.reply(`${step.question}${suffix}`);
}

function buildSummaryText(session: UserSession): string {
  const lines = Object.values(session.answers).map(
    (a) => `<b>${a.field}:</b> ${escapeHtml(a.value)}`
  );
  return ['Проверь свои данные:', '', ...lines].join('\n');
}

async function sendConfirmSummary(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) return;

  session.awaitingConfirm = true;
  sessions[String(userId)] = session;
  saveSessions(sessions);

  await ctx.reply(buildSummaryText(session), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      Markup.button.callback('Подтвердить', 'confirm_yes'),
      Markup.button.callback('Изменить', 'confirm_no'),
    ]),
  });
}

async function finalizeSurvey(ctx: Context, session: UserSession): Promise<void> {
  const users = loadUsers(session.groupChatId);
  const record: UserRecord = {
    userId: session.userId,
    username: session.username,
    groupChatId: session.groupChatId,
    answers: session.answers,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  users[String(session.userId)] = record;
  saveUsers(session.groupChatId, users);

  const sessions = loadSessions();
  delete sessions[String(session.userId)];
  saveSessions(sessions);

  await commitDataChanges(
    `Опрос завершён: пользователь ${session.userId} (группа ${session.groupChatId})`
  );
  await logToGroup(bot, session.groupChatId, record);

  await ctx.reply('Спасибо! Данные сохранены.');
}

bot.command('skip', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.reply('Опрос ещё не начат. Открой ссылку из своей группы.');
    return;
  }
  const survey = loadSurvey(session.groupChatId);
  const step = getStep(survey, session.currentStepId);
  if (!step || !step.optional) {
    await ctx.reply('Этот вопрос нельзя пропустить.');
    return;
  }
  await advance(ctx, session, '(пропущено)');
});

bot.on(message('text'), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.text.startsWith('/')) return; // let command handlers deal with it

  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];

  if (!session) {
    await ctx.reply('Чтобы начать опрос, открой ссылку из своей группы.');
    return;
  }

  if (session.awaitingConfirm) {
    await ctx.reply('Пожалуйста, используй кнопки «Подтвердить» или «Изменить» выше.');
    return;
  }

  const survey = loadSurvey(session.groupChatId);
  const step = getStep(survey, session.currentStepId);
  if (!step) {
    await sendConfirmSummary(ctx);
    return;
  }
  if (step.type !== 'text') {
    await ctx.reply('Ожидается файл/фото для этого вопроса.');
    return;
  }

  await advance(ctx, session, ctx.message.text);
});

bot.on(message('photo'), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.reply('Чтобы начать опрос, открой ссылку из своей группы.');
    return;
  }

  const survey = loadSurvey(session.groupChatId);
  const step = getStep(survey, session.currentStepId);
  if (!step || step.type !== 'photo') {
    await ctx.reply('На этом шаге фото не ожидается.');
    return;
  }

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];
  const file = await ctx.telegram.getFile(bestPhoto.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const relativePath = saveMediaFile(session.groupChatId, session.userId, step.field, buffer, '.jpg');

  session.answers[step.id] = {
    field: step.field,
    value: 'фото прикреплено',
    mediaPath: relativePath,
  };

  const nextId = resolveNextStepId(step, '');
  await proceedTo(ctx, session, nextId);
});

async function advance(ctx: Context, session: UserSession, rawAnswer: string): Promise<void> {
  const survey = loadSurvey(session.groupChatId);
  const step = getStep(survey, session.currentStepId);
  if (!step) return;

  session.answers[step.id] = { field: step.field, value: rawAnswer };
  const nextId = resolveNextStepId(step, rawAnswer);
  await proceedTo(ctx, session, nextId);
}

async function proceedTo(
  ctx: Context,
  session: UserSession,
  nextId: string | undefined
): Promise<void> {
  const sessions = loadSessions();
  const survey = loadSurvey(session.groupChatId);

  if (!nextId || !getStep(survey, nextId)) {
    sessions[String(session.userId)] = session;
    saveSessions(sessions);
    await sendConfirmSummary(ctx);
    return;
  }

  session.currentStepId = nextId;
  sessions[String(session.userId)] = session;
  saveSessions(sessions);
  await askStep(ctx, session.groupChatId, nextId);
}

bot.action('confirm_yes', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.answerCbQuery('Сессия не найдена, начни заново по ссылке из группы');
    return;
  }
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);
  await finalizeSurvey(ctx, session);
});

bot.action('confirm_no', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const sessions = loadSessions();
  const oldSession = sessions[String(userId)];
  if (!oldSession) {
    await ctx.answerCbQuery('Сессия не найдена, начни заново по ссылке из группы');
    return;
  }
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);

  const survey = loadSurvey(oldSession.groupChatId);
  const first = getFirstStep(survey);
  if (!first) return;

  const session: UserSession = {
    privateChatId: oldSession.privateChatId,
    groupChatId: oldSession.groupChatId,
    userId,
    username: oldSession.username,
    currentStepId: first.id,
    answers: {},
    awaitingConfirm: false,
    startedAt: new Date().toISOString(),
  };
  sessions[String(userId)] = session;
  saveSessions(sessions);

  await ctx.reply('Хорошо, начнём заново.');
  await askStep(ctx, session.groupChatId, session.currentStepId);
});

bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.updateType}:`, err);
});

async function main(): Promise<void> {
  const me = await bot.telegram.getMe();
  botUsername = me.username;
  console.log(`NeuroLogin bot starting as @${botUsername} (long polling)...`);
  await bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
