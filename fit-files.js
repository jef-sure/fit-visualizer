const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { default: FitParser } = require('fit-file-parser');

async function parseFitFile(filePath) {
  const content = await fs.readFile(filePath);
  const parser = new FitParser({
    mode: 'list',
    speedUnit: 'km/h',
    lengthUnit: 'km',
    temperatureUnit: 'celsius',
    elapsedRecordField: true,
    force: true,
  });

  return new Promise((resolve, reject) => {
    parser.parse(content, (error, data) => {
      if (error) {
        reject(new Error(typeof error === 'string' ? error : 'Unknown parser error'));
        return;
      }
      resolve(data || {});
    });
  });
}

async function getFitUris(baseDir, useWorkspaceIndex) {
  if (useWorkspaceIndex && vscode.workspace.workspaceFolders?.length) {
    const pattern = new vscode.RelativePattern(baseDir, '**/*.fit');
    return vscode.workspace.findFiles(pattern, '**/node_modules/**');
  }

  const directory = baseDir || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
  return findFitFilesInDirectory(directory);
}

async function findFitFilesInDirectory(rootDir) {
  const fitFiles = [];
  const pendingDirectories = [rootDir];
  const ignoredDirectories = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pendingDirectories.push(fullPath);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.fit')) {
        fitFiles.push(vscode.Uri.file(fullPath));
      }
    }
  }

  return fitFiles;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  fileExists,
  findFitFilesInDirectory,
  getFitUris,
  parseFitFile,
};
