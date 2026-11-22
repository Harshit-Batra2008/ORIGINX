const path = require('path');
const { loadEnvFile } = require('../out/neo4j/neo4jEnv');
const { createNeo4jDriver, resolveNeo4jConfig } = require('../out/neo4j/neo4jService');
const { executeAskWhy } = require('../out/askWhy/askWhyService');
const { clearEvidencePackageCache } = require('../out/evidenceGraph/evidenceGraphRetriever');

loadEnvFile(path.resolve(__dirname, '..'));

async function testLiveAskWhy() {
  const claudeRepoRoot = path.resolve(__dirname, '../../test-repos/Claude-BugHunter');
  const driver = createNeo4jDriver(resolveNeo4jConfig());

  try {
    clearEvidencePackageCache();
    const startTime = Date.now();
    const result = await executeAskWhy({
      repoRoot: claudeRepoRoot,
      filePath: 'engine/scope.py',
      question: 'Why does this code preserve regex patterns instead of lowercasing them?',
      lineRange: { startLine: 37, endLine: 39 },
      neo4jService: driver,
    });
    const duration = Date.now() - startTime;

    console.log('=== LIVE ASK WHY RESULT ===');
    console.log('Retrieval Source :', result.diagnostics.retrievalSource);
    console.log('Is Neo4j Active  :', result.diagnostics.isNeo4jActive);
    console.log('Retrieval Time   :', result.diagnostics.retrievalDurationMs, 'ms');
    console.log('Total Time       :', duration, 'ms');
    console.log('Classification   :', result.evidenceClassification);
    console.log('Supersession     :', result.supersessionStatus);
    console.log('\n--- ANSWER TEXT ---');
    console.log(result.answer);
    console.log('\n--- TOP CITATIONS ---');
    for (const c of result.citations) {
      console.log(`* [${c.type}] ${c.identifier}: ${c.title}`);
    }
  } finally {
    await driver.close();
  }
}

testLiveAskWhy().catch(console.error);
