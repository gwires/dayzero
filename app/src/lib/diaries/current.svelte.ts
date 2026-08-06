// the device-local diary scope, shared reactively by every page. persisted
// in sync_state so it survives reloads; 'all' means no filter.
import { getCurrentDiaryId, setCurrentDiaryId } from '$lib/settings/store';
import { ALL_DIARIES } from './ids';

export const currentDiary = $state({ id: ALL_DIARIES });

/** called once from the root layout; pages rendered before this resolves
 * just show the 'all' scope and re-render when it lands. */
export async function initCurrentDiary(): Promise<void> {
	currentDiary.id = await getCurrentDiaryId();
}

export async function selectDiary(id: string): Promise<void> {
	currentDiary.id = id;
	await setCurrentDiaryId(id);
}

/** the query filter for the current scope: undefined = all diaries. */
export function currentDiaryFilter(): string | undefined {
	return currentDiary.id === ALL_DIARIES ? undefined : currentDiary.id;
}
