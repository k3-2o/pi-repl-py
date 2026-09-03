// --- pi gates skills on the read tool (absent in repl); re-emit them with pi's own formatter in pi's slot ---
import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";

const CWD_MARKER = "\nCurrent working directory:"; // skills sit just before this, pi's last line
const READ_LINE = "Use the read tool to load a skill's file when the task matches its description."; // canon line
const EXECUTE_LINE = "Load a skill's SKILL.md file contents via execute (read the file with Python)."; // repl has no read

/** The prompt with the skills block in pi's slot; undefined if nothing should change. */
export function withSkillsBlock(
	prompt: string,
	skills: Skill[],
	alreadyPresent = prompt.includes("<available_skills>"),
): string | undefined {
	if (skills.length === 0) return undefined;
	let extra = formatSkillsForPrompt(skills);
	if (!extra) return undefined;
	if (alreadyPresent) return undefined;
	extra = extra.replace(READ_LINE, EXECUTE_LINE);
	const idx = prompt.indexOf(CWD_MARKER);
	return idx === -1 ? prompt + extra : prompt.slice(0, idx) + extra + prompt.slice(idx);
}
