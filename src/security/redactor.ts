/**
 * Security Redactor: Detects sensitive credentials and redacts or blocks them before sending to external APIs.
 */

export interface SensitivePattern {
  name: string;
  pattern: RegExp;
  isCritical: boolean; // Critical secrets trigger request blocking
}

export const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // Critical: Unmasked private keys
  {
    name: 'Private Key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gi,
    isCritical: true
  },
  // Critical: AWS Access Keys (20-32 characters starting with AKIA, ABIA, ACCA, ASIA)
  {
    name: 'AWS Access Key ID',
    pattern: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16,28}\b/g,
    isCritical: true
  },
  // Critical: GitHub Personal Access Tokens
  {
    name: 'GitHub Token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    isCritical: true
  },
  // Critical: Google / Gemini API Keys
  {
    name: 'Google API Key',
    pattern: /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,
    isCritical: true
  },
  // Critical: Slack Tokens
  {
    name: 'Slack Token',
    pattern: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}\b/g,
    isCritical: true
  },
  // Critical: Stripe Live Secret Keys
  {
    name: 'Stripe Secret Key',
    pattern: /\b(?:sk_live|rk_live)_[0-9a-zA-Z]{24,}\b/g,
    isCritical: true
  },
  // Redactable: Bearer Tokens / JWTs
  {
    name: 'Bearer Token',
    pattern: /\bBearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi,
    isCritical: false
  },
  // Redactable: Generic hardcoded password/secret string assignments
  {
    name: 'Hardcoded Secret Assignment',
    pattern: /(?<=\b(?:password|passwd|api_key|apikey|secret|auth_token)\s*[:=]\s*["'])([^"']{6,})(?=["'])/gi,
    isCritical: false
  }
];

export interface ScanResult {
  isBlocked: boolean;
  blockReason?: string;
  detectedCriticalTypes: string[];
  sanitizedText: string;
  redactionCount: number;
}

/**
 * Scans a given text block for sensitive credentials.
 * If critical credentials (e.g. private keys, real cloud tokens) are found, isBlocked is true.
 * For other potential tokens (e.g. bearer tokens, password strings), redacts them with [REDACTED_SECRET].
 */
export function scanAndSanitize(text: string): ScanResult {
  if (!text) {
    return {
      isBlocked: false,
      detectedCriticalTypes: [],
      sanitizedText: '',
      redactionCount: 0
    };
  }

  const detectedCriticalTypes: string[] = [];
  let isBlocked = false;

  // 1. Check for critical patterns first
  for (const item of SENSITIVE_PATTERNS) {
    if (item.isCritical) {
      item.pattern.lastIndex = 0;
      if (item.pattern.test(text)) {
        isBlocked = true;
        detectedCriticalTypes.push(item.name);
      }
    }
  }

  if (isBlocked) {
    return {
      isBlocked: true,
      blockReason: `Detected sensitive credentials: ${detectedCriticalTypes.join(', ')}`,
      detectedCriticalTypes,
      sanitizedText: text,
      redactionCount: 0
    };
  }

  // 2. Perform redactions for non-critical sensitive patterns
  let sanitized = text;
  let redactionCount = 0;

  for (const item of SENSITIVE_PATTERNS) {
    if (!item.isCritical) {
      item.pattern.lastIndex = 0;
      sanitized = sanitized.replace(item.pattern, (match) => {
        redactionCount++;
        if (item.name === 'Bearer Token') {
          return 'Bearer [REDACTED_TOKEN]';
        }
        return '[REDACTED_SECRET]';
      });
    }
  }

  return {
    isBlocked: false,
    detectedCriticalTypes: [],
    sanitizedText: sanitized,
    redactionCount
  };
}

/**
 * Scans an entire payload including selected code, commit messages, and diffs.
 */
export function scanPayload(payload: {
  selectedText: string;
  commitSubjects: string[];
  commitBodies: string[];
  diffs: string[];
}): {
  isBlocked: boolean;
  blockReason?: string;
  sanitizedSelectedText: string;
  sanitizedDiffs: string[];
} {
  // Check selected code
  const codeCheck = scanAndSanitize(payload.selectedText);
  if (codeCheck.isBlocked) {
    return {
      isBlocked: true,
      blockReason: `In selected code: ${codeCheck.blockReason}`,
      sanitizedSelectedText: payload.selectedText,
      sanitizedDiffs: payload.diffs
    };
  }

  // Check commit metadata
  for (const subject of payload.commitSubjects) {
    const check = scanAndSanitize(subject);
    if (check.isBlocked) {
      return {
        isBlocked: true,
        blockReason: `In commit subject: ${check.blockReason}`,
        sanitizedSelectedText: payload.selectedText,
        sanitizedDiffs: payload.diffs
      };
    }
  }

  for (const body of payload.commitBodies) {
    const check = scanAndSanitize(body);
    if (check.isBlocked) {
      return {
        isBlocked: true,
        blockReason: `In commit message: ${check.blockReason}`,
        sanitizedSelectedText: payload.selectedText,
        sanitizedDiffs: payload.diffs
      };
    }
  }

  // Check diffs
  const sanitizedDiffs: string[] = [];
  for (const diff of payload.diffs) {
    const diffCheck = scanAndSanitize(diff);
    if (diffCheck.isBlocked) {
      return {
        isBlocked: true,
        blockReason: `In commit diff: ${diffCheck.blockReason}`,
        sanitizedSelectedText: payload.selectedText,
        sanitizedDiffs: payload.diffs
      };
    }
    sanitizedDiffs.push(diffCheck.sanitizedText);
  }

  return {
    isBlocked: false,
    sanitizedSelectedText: codeCheck.sanitizedText,
    sanitizedDiffs
  };
}
