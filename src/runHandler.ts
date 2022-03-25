import * as vscode from "vscode";
import {
  AggregatedResult,
  getNodeVersion,
  getTempPath,
  getVitestPath as getVitestPath,
  TestRunner,
} from "./pure/runner";
import groupBy = require("lodash.groupby");
import {
  getAllTestCases,
  WEAKMAP_TEST_DATA,
  getTestCaseId,
  TestFile,
} from "./TestData";
import { getConfig } from "./config";
import { readFile } from "fs-extra";
import { existsSync } from "fs";

export async function runHandler(
  ctrl: vscode.TestController,
  request: vscode.TestRunRequest,
  cancellation: vscode.CancellationToken
) {
  if (
    vscode.workspace.workspaceFolders === undefined ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    return;
  }

  const runner = new TestRunner(
    vscode.workspace.workspaceFolders[0].uri.path,
    getVitestPath(vscode.workspace.workspaceFolders[0].uri.path)
  );

  const tests = request.include ?? gatherTestItems(ctrl.items);
  const run = ctrl.createTestRun(request);
  await runTest(ctrl, runner, run, tests);
  run.end();
}

export async function debugHandler(
  ctrl: vscode.TestController,
  request: vscode.TestRunRequest
) {
  if (
    vscode.workspace.workspaceFolders === undefined ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    return;
  }

  const tests = request.include ?? gatherTestItems(ctrl.items);
  const run = ctrl.createTestRun(request);
  await runTest(ctrl, undefined, run, tests, true);
  run.end();
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}

async function runTest(
  ctrl: vscode.TestController,
  runner: TestRunner | undefined,
  run: vscode.TestRun,
  items: readonly vscode.TestItem[],
  isDebug = false
) {
  if (!isDebug && runner === undefined) {
    throw new Error("should provide runner if not debug");
  }

  const config = getConfig();
  const testCaseSet: Set<vscode.TestItem> = new Set();
  const testItemIdMap = new Map<string, vscode.TestItem>();
  const fileItems: vscode.TestItem[] = [];
  for (const item of items) {
    const testingData = WEAKMAP_TEST_DATA.get(item);
    if (!testingData) {
      console.error("Item not found");
      throw new Error("Item not found");
    }

    if (testingData instanceof TestFile) {
      await testingData.load(ctrl);
    }

    let file: vscode.TestItem;
    if (testingData instanceof TestFile) {
      file = item;
    } else {
      file = testingData.fileItem;
      if (!file) {
        throw new Error("file item not found");
      }
    }

    fileItems.push(file);
    const fileTestCases = getAllTestCases(file);
    for (const testCase of fileTestCases) {
      // remove suffix of test item id
      // e.g. "test-case@1" -> "test-case"
      // TODO: refactor
      testItemIdMap.set(testCase.id.replace(/@\d+$/g, ""), testCase);
    }

    for (const test of getAllTestCases(item)) {
      testCaseSet.add(test);
    }
  }

  testCaseSet.forEach((testCase) => {
    run.started(testCase);
  });

  const pathToFile = new Map<string, vscode.TestItem>();
  for (const file of fileItems) {
    pathToFile.set(file.uri!.path, file);
  }

  let out;

  try {
    if (!isDebug) {
      out = await runner!.scheduleRun(
        fileItems.map((x) => x.uri!.fsPath),
        items.length === 1
          ? WEAKMAP_TEST_DATA.get(items[0])!.getFullPattern()
          : "",
        items.length === 1
          ? (msg) => run.appendOutput(msg, undefined, items[0])
          : (msg) => run.appendOutput(msg),
        config.env || undefined,
        config.commandLine ? config.commandLine.trim().split(" ") : undefined
      );
    } else {
      out = await debugTest(vscode.workspace.workspaceFolders![0], run, items);
    }
  } catch (e) {
    console.error(e);
    run.appendOutput("Run test failed \r\n" + (e as Error) + "\r\n");
    run.appendOutput("" + (e as Error)?.stack + "\r\n");
    testCaseSet.forEach((testCase) => {
      run.errored(testCase, new vscode.TestMessage((e as Error)?.toString()));
    });
    testCaseSet.clear();
  }

  if (out === undefined) {
    testCaseSet.forEach((testCase) => {
      run.errored(testCase, new vscode.TestMessage("Internal Error"));
    });
    return;
  }

  if (out.testResults.length !== 0) {
    Object.values(groupBy(out.testResults, (x) => x.testFilePath)).forEach(
      (results) => {
        results.forEach((result, index) => {
          const id =
            getTestCaseId(
              pathToFile.get(result?.testFilePath || "")!,
              result.displayName!
            ) || "";
          const child = testItemIdMap.get(id)!;
          if (!child || !testCaseSet.has(child)) {
            return;
          }

          testCaseSet.delete(child);
          switch (result.status) {
            case "pass":
              run.passed(child, result.perfStats?.runtime);
              return;
            case "fail":
              run.failed(
                child,
                new vscode.TestMessage(result.failureMessage || "")
              );
              return;
          }

          if (result.skipped || result.status == null) {
            run.skipped(child);
          }
        });
      }
    );
    testCaseSet.forEach((testCase) => {
      run.errored(
        testCase,
        new vscode.TestMessage(
          `Test result not found. \n` +
            `Can you run vitest successfully on this file? Does it need custom option to run?\n` +
            `Does this file contain test case with the same name? \n`
        )
      );
      run.appendOutput(`Cannot find test ${testCase.id}`);
    });
  } else {
    testCaseSet.forEach((testCase) => {
      run.errored(
        testCase,
        new vscode.TestMessage(
          "Unexpected condition. Please report the bug to https://github.com/zxch3n/vitest-explorer/issues"
        )
      );
    });
  }
}

async function debugTest(
  workspaceFolder: vscode.WorkspaceFolder,
  run: vscode.TestRun,
  testItems: readonly vscode.TestItem[]
) {
  let config = {
    type: "pwa-node",
    request: "launch",
    name: "Debug Current Test File",
    autoAttachChildProcesses: true,
    skipFiles: ["<node_internals>/**", "**/node_modules/**"],
    program: getVitestPath(workspaceFolder.uri.path),
    args: [] as string[],
    smartStep: true,
    console: "integratedTerminal",
  };

  const outputFilePath = getTempPath();
  const testData = testItems.map((item) => WEAKMAP_TEST_DATA.get(item)!);
  config.args = [
    "run",
    ...new Set(testData.map((x) => x.getFilePath())),
    testData.length === 1 ? "--testNamePattern" : "",
    testData.length === 1 ? testData[0].getFullPattern() : "",
    "--reporter=default",
    "--reporter=json",
    "--outputFile",
    outputFilePath,
  ];

  if (config.program == null) {
    vscode.window.showErrorMessage("Cannot find vitest");
    return;
  }

  return new Promise<AggregatedResult>((resolve, reject) => {
    vscode.debug.startDebugging(workspaceFolder, config).then(
      () => {
        vscode.debug.onDidChangeActiveDebugSession((e) => {
          if (!e) {
            console.log("DISCONNECTED");
            setTimeout(async () => {
              if (!existsSync(outputFilePath)) {
                const prefix =
                  `When running:\n` +
                  `    ${config.program + " " + config.args.join(" ")}\n` +
                  `cwd: ${workspaceFolder.uri.fsPath}\n` +
                  `node: ${await getNodeVersion()}` +
                  `env.PATH: ${process.env.PATH}`;
                reject(new Error(prefix));
                return;
              }

              const file = await readFile(outputFilePath, "utf-8");
              const out = JSON.parse(file) as AggregatedResult;
              resolve(out);
            });
          }
        });
      },
      (err) => {
        console.error(err);
        console.log("START DEBUGGING FAILED");
        reject();
      }
    );
  });
}
