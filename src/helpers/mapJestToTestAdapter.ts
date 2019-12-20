import {
  IParseResults,
  JestAssertionResults,
  JestFileResults,
  TestAssertionStatus,
  TestReconciler,
} from "jest-editor-support";
import { TestDecoration, TestInfo, TestSuiteInfo } from "vscode-test-adapter-api";
import { DESCRIBE_ID_SEPARATOR, TEST_ID_SEPARATOR } from "../constants";
import { IJestResponse, ITestFilter } from "../types";
import escapeRegExp from "./escapeRegExp";

function getAssertionStatus(
  result: JestAssertionResults,
  file: string,
  reconciler?: TestReconciler,
): TestAssertionStatus | undefined {
  if (reconciler) {
    const fileResult = reconciler.assertionsForTestFile(file) || [];
    return fileResult.find(x => x.title === result.fullName);
  }
  return undefined;
}

function merge(
  mergeDestination: Array<TestSuiteInfo | TestInfo>,
  mergeSource: Array<TestSuiteInfo | TestInfo>,
): Array<TestSuiteInfo | TestInfo> {
  mergeSource.forEach(suiteResult => {
    const existingResult = mergeDestination.find(result => result.id === suiteResult.id);
    if (existingResult && (existingResult as TestSuiteInfo).children && (suiteResult as TestSuiteInfo).children) {
      merge((existingResult as TestSuiteInfo).children, (suiteResult as TestSuiteInfo).children);
    } else {
      mergeDestination.push(suiteResult);
    }
  });

  return mergeDestination;
}

export function mapJestResponseToTestSuiteInfo(
  { results }: IJestResponse,
  workDir: string,
): TestSuiteInfo {
  const suiteResults = results.testResults.map((t) =>
    mapJestFileResultToTestSuiteInfo(t, workDir),
  );

  return {
    children: merge([], suiteResults),
    id: "root",
    label: "Jest",
    type: "suite",
  };
}

function transformFileResultIntoTree(
  resultFileName: string,
  workDir: string,
  fileTestCases: Array<TestSuiteInfo | TestInfo>,
): TestSuiteInfo {
  const pathSeparator = resultFileName.indexOf("/") !== -1 ? "/" : "\\";
  const path = resultFileName.replace(new RegExp(escapeRegExp(workDir), "ig"), "").split(pathSeparator);
  const lastPathElement = path[path.length - 1];
  const lastChild: TestSuiteInfo = {
    children: fileTestCases,
    file: resultFileName,
    id: lastPathElement,
    label: lastPathElement,
    type: "suite",
  };
  return createDirectoryStructure(lastChild, path, path.length - 2);
}

function createDirectoryStructure(
  currentLevel: TestSuiteInfo,
  thePath: string[],
  currentPathIndex: number,
): TestSuiteInfo {
  let currentPathElement = thePath[currentPathIndex];
  if (currentPathElement === "") {
    currentPathIndex--;
    currentPathElement = thePath[currentPathIndex];
  }
  if (currentPathElement === undefined) {
    return currentLevel;
  }

  const nextLevel: TestSuiteInfo = {
    children: [currentLevel],
    id: currentPathElement,
    label: currentPathElement,
    type: "suite",
  };

  return createDirectoryStructure(nextLevel, thePath, currentPathIndex - 1);
}

export function mapJestFileResultToTestSuiteInfo(result: JestFileResults, workDir: string): TestSuiteInfo {
  const testSuites = result.assertionResults
    .filter(testResult => testResult.ancestorTitles && testResult.ancestorTitles.length > 0)
    .reduce((testTree, testResult) => {
      const target = (testResult.ancestorTitles as string[]).reduce((innerTree, ancestorTitle, i, a) => {
        const fullName = a.slice(0, i + 1).join(" ");
        const id = getTestId(result.name, fullName);
        let next = innerTree.find(x => x.id === id);
        if (next) {
          return (next as TestSuiteInfo).children;
        } else {
          next = {
            children: [],
            file: result.name,
            id,
            label: ancestorTitle,
            type: "suite",
          };
          innerTree.push(next);
          return next.children;
        }
      }, testTree);

      target.push(mapJestAssertionToTestInfo(testResult, result));

      return testTree;
    }, new Array<TestSuiteInfo | TestInfo>());

  const testCases: Array<TestSuiteInfo | TestInfo> = result.assertionResults
    .filter(testResult => !testResult.ancestorTitles || testResult.ancestorTitles.length === 0)
    .map(testResult => mapJestAssertionToTestInfo(testResult, result));

  return transformFileResultIntoTree(result.name, workDir, testCases.concat(testSuites));
}

export function mapJestParseToTestSuiteInfo(loadedTests: IParseResults[], workDir: string): TestSuiteInfo {
  const testSuiteInfos = loadedTests
    .map(testFile => {
      let fileName = null;
      const testCases = testFile.itBlocks.map(itBlock => {
        fileName = itBlock.file;

        const testName = itBlock.name ? itBlock.name : "test has no name";

        return {
          file: fileName,
          id: getTestId(fileName, testName),
          label: testName,
          line: itBlock.start.line,
          skipped: false,
          type: "test",
        } as TestInfo;
      });

      return fileName ? transformFileResultIntoTree(fileName, workDir, testCases) : null;
    })
    .filter(testSuiteInfo => testSuiteInfo) as TestSuiteInfo[];

  return {
    children: merge([], testSuiteInfos),
    id: "root",
    label: "Jest",
    type: "suite",
  };
}

export function mapJestAssertionToTestDecorations(
  result: JestAssertionResults,
  file: string,
  reconciler?: TestReconciler,
): TestDecoration[] {
  const assertionResult = getAssertionStatus(result, file, reconciler);
  if (assertionResult) {
    return [
      {
        line: assertionResult.line || 0,
        message: assertionResult.terseMessage || "",
      },
    ];
  }
  return [];
}

export function mapJestAssertionToTestInfo(
  assertionResult: JestAssertionResults,
  fileResult: JestFileResults,
  reconciler?: TestReconciler,
): TestInfo {
  const assertionStatus = getAssertionStatus(assertionResult, fileResult.name, reconciler);
  let line: number | undefined;
  let skipped: boolean = false;
  if (assertionStatus) {
    line = assertionStatus.line;
    skipped = assertionStatus.status === "KnownSkip";
  }

  return {
    file: fileResult.name,
    id: getTestId(fileResult.name, assertionResult.title),
    label: assertionResult.title,
    line,
    skipped,
    type: "test",
  };
}

export function getTestId(fileName: string, testName: string): string {
  return `${escapeRegExp(fileName)}${TEST_ID_SEPARATOR}^${escapeRegExp(testName)}$`.toLowerCase();
}

export function mapJestAssertionToId(result: JestAssertionResults): string {
  return `^${escapeRegExp(result.fullName)}$`;
}

export function mapAssertionResultToTestId(assertionResult: JestAssertionResults, fileName: string) {
  // we seem to get an issue with the casing of the drive letter in Windows at least.  We are going to lowercase
  // the letter.
  const driveLetterRegex = /^([a-zA-Z])\:\\/;
  if (driveLetterRegex.test(fileName)) {
    fileName = fileName.replace(driveLetterRegex, x => x.toLowerCase())
}

  // TODO we may be able to rationalise the code that generates ids here.
  const describeBlocks = assertionResult.ancestorTitles && assertionResult.ancestorTitles.length > 0
    ? DESCRIBE_ID_SEPARATOR + assertionResult.ancestorTitles.join(DESCRIBE_ID_SEPARATOR)
    : "";
  const testId = `${fileName}${describeBlocks}${TEST_ID_SEPARATOR}${assertionResult.title}`;
  return testId;
}

export function mapTestIdsToTestFilter(tests: string[]): ITestFilter | null {
  if (tests[0] && tests[0] === "root") {
    return null;
  }

  const results = tests
    .map(t => t.split(RegExp(`${TEST_ID_SEPARATOR}|${DESCRIBE_ID_SEPARATOR}`)))
    .reduce(
      (acc, [f, ...rest]) => {
        // add the file if it is not already in the list of files.
        if (!acc.fileNames.includes(f)) {
          acc.fileNames.push(f);
        }
        // add the tests to the tests if not already present.
        if (rest && rest.length > 0) {
          const testName = rest[rest.length - 1];
          if (!acc.testNames.includes(testName)) {
            acc.testNames.push(testName);
          }
        }
        return acc;
      },
      {
        fileNames: [] as string[],
        testNames: [] as string[],
      },
    );

  // we accumulate the file and test names into regex expressions.  Note we escape the names to avoid interpreting
  // any regex control characters in the file or test names.
    return {
    testFileNamePattern: `(${results.fileNames.map(escapeRegExp).join("|")})`,
    testNamePattern: results.testNames.length > 0 ? `(${results.testNames.map(escapeRegExp).join("|")})` : undefined,
    };
  }
