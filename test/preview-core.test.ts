/**
 * The preview scorer's specification.
 *
 * A collapsed cell has one line to say what it did. These tables pin, per cell
 * shape, which line wins and how it is presented. This evaluator runs Python,
 * so the file-effect idioms are pathlib/open/shutil/os, and the generic
 * fallback scores Python line shapes. Secrets never leak.
 */

import { describe, expect, test } from "bun:test";
import { descriptor, previewCell } from "../src/extension/preview/index.js";

interface Case {
	name: string;
	code: string;
	text: string;
}

function run(cases: Case[]): void {
	for (const c of cases) {
		test(c.name, () => {
			const preview = previewCell(c.code);
			expect(preview.text).toBe(c.text);
		});
	}
}

describe("previewCell: python file effects", () => {
	run([
		{
			name: "pathlib write shows the verb and the path",
			code: 'Path("data.csv").write_text("a,b\\n")',
			text: "write data.csv",
		},
		{
			name: "a read held in a const still reads",
			code: 'raw = Path("notes.md").read_text()\nraw[:400]',
			text: "read notes.md",
		},
		{
			name: "mkdir keeps its verb",
			code: 'Path("dist").mkdir(parents=True, exist_ok=True)',
			text: "mkdir dist",
		},
		{
			name: "unlink shows delete",
			code: 'Path("tmp/report").unlink(missing_ok=True)',
			text: "delete tmp/report",
		},
		{
			name: "a with-open append block previews the target file",
			code: 'with open("log.txt", "a") as f:\n    f.write(line)',
			text: "append log.txt",
		},
		{
			name: "a bare open write mode says write",
			code: 'open("out.txt", "w")',
			text: "write out.txt",
		},
		{
			name: "open read mode says read",
			code: 'open("f.txt", "r").read()',
			text: "read f.txt",
		},
		{
			name: "shutil.rmtree is a delete",
			code: 'shutil.rmtree("build")',
			text: "delete build",
		},
		{
			name: "os.rename shows both ends",
			code: 'os.rename("old.csv", "new.csv")',
			text: "rename old.csv → new.csv",
		},
		{
			name: "a variable path falls back to the generic line, not a phantom file",
			code: 'p = "x.csv"\nPath(p).write_text("y")',
			text: 'Path(p).write_text("y")',
		},
	]);
});

describe("previewCell: generic python", () => {
	run([
		{
			name: "a bare call outranks the assignment above it",
			code: 'results = web_search("pi agents")\nprint(results[0].title)',
			text: "print(results[0].title)",
		},
		{
			name: "a python assignment call is meaningful on its own",
			code: 'df = pd.read_csv("data.csv")',
			text: 'df = pd.read_csv("data.csv")',
		},
		{
			name: "imports and comments never win",
			code: '# setup\nimport pandas as pd\nfrom pathlib import Path\nprint("hello")',
			text: 'print("hello")',
		},
		{
			name: "empty code previews as empty",
			code: "",
			text: "",
		},
	]);
});

describe("descriptor hygiene", () => {
	test("collapses whitespace and caps at 64 characters", () => {
		expect(descriptor("a   b\n\t c")).toBe("a b c");
		const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho";
		expect(descriptor(long).length).toBe(64);
		expect(descriptor(long).endsWith("…")).toBe(true);
	});

	test("redacts secrets and giant blobs", () => {
		expect(descriptor('token="hunter2secret"')).toBe("token=<redacted>");
		expect(descriptor("A".repeat(120))).toBe("<blob>");
	});
});
