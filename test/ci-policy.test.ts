import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const macosWorkflowPath = new URL(
  '../.github/workflows/ci-macos.yml',
  import.meta.url,
);

describe('GitHub Actions budget policy', () => {
  it('keeps normal CI on Linux and reserves macOS for scheduled or manual smoke', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const macosWorkflow = readFileSync(macosWorkflowPath, 'utf8');

    expect(workflow).not.toMatch(/os:\s*\[[^\]]*macos/i);
    expect(workflow).not.toContain('runs-on: macos-latest');
    expect(macosWorkflow).toContain('workflow_dispatch:');
    expect(macosWorkflow).toContain('schedule:');
    expect(macosWorkflow).toContain('runs-on: macos-latest');
  });

  it('cancels superseded branch runs and skips documentation-only changes', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow.match(/paths-ignore:/g)).toHaveLength(2);
    expect(workflow).toContain("- 'docs/**'");
    expect(workflow).toContain("- '**/*.md'");
  });
});
