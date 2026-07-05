import { Telegraf } from 'telegraf';
import { UserRecord } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRecord(record: UserRecord): string {
  const lines = [
    '<b>Анкета подтверждена</b>',
    `Пользователь: <code>${record.userId}</code>${record.username ? ' (@' + record.username + ')' : ''}`,
    '',
    ...Object.values(record.answers).map((a) => `<b>${a.field}:</b> ${escapeHtml(a.value)}`),
    '',
    `Подтверждено: ${record.confirmedAt}`,
  ];
  return lines.join('\n');
}

/**
 * Posts a copy of the confirmed record back into the group it came from.
 * This turns the group itself into a human-readable log of authorized
 * members, in addition to the JSON copy stored in the repository.
 */
export async function logToGroup(
  bot: Telegraf,
  groupChatId: number,
  record: UserRecord
): Promise<void> {
  try {
    await bot.telegram.sendMessage(groupChatId, formatRecord(record), {
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error(`Failed to log confirmed record to group ${groupChatId}:`, err);
  }
}
