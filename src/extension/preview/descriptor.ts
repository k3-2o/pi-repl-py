const DESCRIPTOR_MAX_WIDTH = 64;

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) return text;
	return `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

// --- strip blobs, secrets, and sk- keys before a line reaches the header ---
function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[=:]\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*[=:]\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

export function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}
