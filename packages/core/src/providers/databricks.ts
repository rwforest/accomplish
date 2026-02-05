import type { DatabricksConfig } from '@accomplish/shared';
import { fetchWithTimeout } from '../utils/fetch.js';
import { sanitizeString } from '../utils/sanitize.js';
import { validateHttpUrl } from '../utils/url.js';

const DEFAULT_TIMEOUT_MS = 15000;

export interface DatabricksConnectionResult {
    success: boolean;
    error?: string;
    endpoints?: DatabricksEndpoint[];
}

export interface DatabricksEndpoint {
    id: string;
    name: string;
    state: string;
    creator?: string;
}

interface DatabricksEndpointsResponse {
    endpoints?: Array<{
        name: string;
        state: string;
        creator?: string;
        config?: {
            served_entities?: Array<{
                entity_name?: string;
                foundation_model_name?: string;
            }>;
        };
    }>;
}

/**
 * Tests connection to a Databricks workspace and retrieves available serving endpoints.
 *
 * @param workspaceUrl - The Databricks workspace URL (e.g., https://adb-xxx.azuredatabricks.net)
 * @param apiToken - Databricks Personal Access Token (PAT)
 * @returns Connection result with available endpoints on success
 */
export async function testDatabricksConnection(
    workspaceUrl: string,
    apiToken: string
): Promise<DatabricksConnectionResult> {
    const sanitizedUrl = sanitizeString(workspaceUrl, 'databricksUrl', 256);
    const sanitizedToken = sanitizeString(apiToken, 'apiToken', 256);

    try {
        validateHttpUrl(sanitizedUrl, 'Databricks workspace URL');
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Invalid URL format' };
    }

    const baseUrl = sanitizedUrl.replace(/\/$/, '');

    try {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${sanitizedToken}`,
            'Content-Type': 'application/json',
        };

        // List serving endpoints via Databricks API
        const response = await fetchWithTimeout(
            `${baseUrl}/api/2.0/serving-endpoints`,
            { method: 'GET', headers },
            DEFAULT_TIMEOUT_MS
        );

        if (!response.ok) {
            if (response.status === 401) {
                return { success: false, error: 'Invalid API token. Please check your Databricks Personal Access Token.' };
            }
            if (response.status === 403) {
                return { success: false, error: 'Access denied. Your token may not have permission to access serving endpoints.' };
            }
            const errorData = (await response.json().catch(() => ({}))) as {
                error_code?: string;
                message?: string;
            };
            const errorMessage = errorData?.message || `API returned status ${response.status}`;
            return { success: false, error: errorMessage };
        }

        const data = (await response.json()) as DatabricksEndpointsResponse;
        const endpoints: DatabricksEndpoint[] = (data.endpoints || []).map((ep) => ({
            id: ep.name,
            name: ep.name,
            state: ep.state,
            creator: ep.creator,
        }));

        console.log(`[Databricks] Connection successful, found ${endpoints.length} serving endpoints`);
        return { success: true, endpoints };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        console.warn('[Databricks] Connection failed:', message);

        if (error instanceof Error && error.name === 'AbortError') {
            return { success: false, error: 'Connection timed out. Check your workspace URL and network connection.' };
        }
        return { success: false, error: `Cannot connect to Databricks: ${message}` };
    }
}

/**
 * Validates a specific Databricks serving endpoint by making a minimal chat completion request.
 *
 * @param workspaceUrl - The Databricks workspace URL
 * @param endpointName - The serving endpoint name
 * @param apiToken - Databricks Personal Access Token
 * @returns Validation result
 */
export async function validateDatabricksEndpoint(
    workspaceUrl: string,
    endpointName: string,
    apiToken: string
): Promise<{ valid: boolean; error?: string }> {
    const baseUrl = workspaceUrl.replace(/\/$/, '');
    const sanitizedEndpoint = sanitizeString(endpointName, 'endpointName', 128);

    try {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
        };

        // Test the endpoint with a minimal chat completion request
        const response = await fetchWithTimeout(
            `${baseUrl}/serving-endpoints/${sanitizedEndpoint}/invocations`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                }),
            },
            DEFAULT_TIMEOUT_MS
        );

        if (!response.ok) {
            if (response.status === 401) {
                return { valid: false, error: 'Invalid API token' };
            }
            if (response.status === 404) {
                return { valid: false, error: `Endpoint "${sanitizedEndpoint}" not found` };
            }
            const errorData = (await response.json().catch(() => ({}))) as {
                error_code?: string;
                message?: string;
            };
            const errorMessage = errorData?.message || `API returned status ${response.status}`;
            return { valid: false, error: errorMessage };
        }

        console.log('[Databricks] Endpoint validation successful:', sanitizedEndpoint);
        return { valid: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Validation failed';
        console.warn('[Databricks] Endpoint validation failed:', message);

        if (error instanceof Error && error.name === 'AbortError') {
            return { valid: false, error: 'Request timed out' };
        }
        return { valid: false, error: message };
    }
}

export interface FetchDatabricksEndpointsOptions {
    config: DatabricksConfig | null;
    apiToken?: string;
}

/**
 * Fetches available serving endpoints from a configured Databricks workspace.
 *
 * @param options - Configuration and API token
 * @returns Result with available endpoints on success
 */
export async function fetchDatabricksEndpoints(
    options: FetchDatabricksEndpointsOptions
): Promise<DatabricksConnectionResult> {
    const { config, apiToken } = options;

    if (!config || !config.workspaceUrl) {
        return { success: false, error: 'No Databricks workspace configured' };
    }

    if (!apiToken) {
        return { success: false, error: 'API token is required' };
    }

    return testDatabricksConnection(config.workspaceUrl, apiToken);
}
