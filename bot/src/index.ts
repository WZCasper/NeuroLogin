import 'dotenv/config';
import { Telegraf, Markup, Context } from 'telegraf';
import {
  loadUsers,
  saveUsers,
  loadSessions,
  saveSessions,
  loadSurvey,
  saveMediaFile,
} from './lib/storage';
import { commitDataChanges } from './lib/git';
import { logToAdminGroup } from './lib/notify';
import { getStep, getFirstStep, resolveNextStepId } from './lib/surveyEngine';
import { UserSession, UserRecord } from './lib/types';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set');
}

const bot = new Telegraf(BOT_TOKEN);

function startSession(userId: number, chatId: number, username?: string): UserSession {
  const survey = loadSurvey();
  const first = getFirstStep(survey);
  const session: UserSession = {
    chatId,
    userId,
    username,
    currentStepId: first ? first.id : 'confirm',
    answers: {},
    awaitingConfirm: false,
    startedAt: new Date().toISOString(),
  };
  const sessions = loadSessions();
  sessions[String(userId)] = session;
  saveSessions(sessions);
  return session;
}

async function askStep(ctx: Context, stepId: string): Promise<void> {
  const survey = loadSurvey();
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  await ctx.reply(
    buildSummaryText(session),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        Markup.button.callback('Подтвердить', 'confirm_yes'),
        Markup.button.callback('Изменить', 'confirm_no'),
      ]),
    }
  );
}

async function finalizeSurvey(ctx: Context, session: UserSession): Promise<void> {
  const users = loadUsers();
  const record: UserRecord = {
    userId: session.userId,
    username: session.username,
    chatId: session.chatId,
    answers: session.answers,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  users[String(session.userId)] = record;
  saveUsers(users);

  const sessions = loadSessions();
  delete sessions[String(session.userId)];
  saveSessions(sessions);

  await commitDataChanges(`Опрос завершён: пользователь ${session.userId}`);
  await logToAdminGroup(bot, record);

  await ctx.reply('Спасибо! Данные сохранены.');
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const username = ctx.from.username;
  const session = startSession(userId, chatId, username);
  await ctx.reply('Начинаем короткий опрос.');
  await askStep(ctx, session.currentStepId);
});

bot.command('skip', async (ctx) => {
  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.reply('Опрос ещё не начат. Отправь /start.');
    return;
  }
  const survey = loadSurvey();
  const step = getStep(survey, session.currentStepId);
  if (!step || !step.optional) {
    await ctx.reply('Этот вопрос нельзя пропустить.');
    return;
  }
  await advance(ctx, session, '(пропущено)');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];

  if (!session) {
    await ctx.reply('Чтобы начать опрос, отправь /start.');
    return;
  }

  if (session.awaitingConfirm) {
    // User typed instead of pressing a button — remind them.
    await ctx.reply('Пожалуйста, используй кнопки «Подтвердить» или «Изменить» выше.');
    return;
  }

  const survey = loadSurvey();
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

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.reply('Чтобы начать опрос, отправь /start.');
    return;
  }

  const survey = loadSurvey();
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
  const extension = '.jpg';
  const relativePath = saveMediaFile(session.userId, step.field, buffer, extension);

  session.answers[step.id] = {
    field: step.field,
    value: 'фото прикреплено',
    mediaPath: relativePath,
  };

  const nextId = resolveNextStepId(step, '');
  await proceedTo(ctx, session, nextId);
});

async function advance(ctx: Context, session: UserSession, rawAnswer: string): Promise<void> {
  const survey = loadSurvey();
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

  if (!nextId || !getStep(loadSurvey(), nextId)) {
    sessions[String(session.userId)] = session;
    saveSessions(sessions);
    await sendConfirmSummary(ctx);
    return;
  }

  session.currentStepId = nextId;
  sessions[String(session.userId)] = session;
  saveSessions(sessions);
  await askStep(ctx, nextId);
}

bot.action('confirm_yes', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const sessions = loadSessions();
  const session = sessions[String(userId)];
  if (!session) {
    await ctx.answerCbQuery('Сессия не найдена, начни заново с /start');
    return;
  }
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);
  await finalizeSurvey(ctx, session);
});

bot.action('confirm_no', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);
  const session = startSession(userId, ctx.chat!.id, ctx.from?.username);
  await ctx.reply('Хорошо, начнём заново.');
  await askStep(ctx, session.currentStepId);
});

bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.updateType}:`, err);
});

async function main(): Promise<void> {
  console.log('NeuroLogin bot starting (long polling)...');
  await bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
