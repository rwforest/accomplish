/**
 * Databricks Foundation Model API Provider Form
 *
 * Enables connection to Databricks serving endpoints using Personal Access Token.
 */

import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getAccomplish } from '@/lib/accomplish';
import { settingsVariants, settingsTransitions } from '@/lib/animations';
import type { ConnectedProvider, DatabricksCredentials } from '@accomplish/shared';
import {
    ConnectButton,
    ConnectedControls,
    ProviderFormHeader,
    FormError,
    ModelSelector,
} from '../shared';

import databricksLogo from '/assets/ai-logos/databricks.svg';

interface DatabricksEndpoint {
    id: string;
    name: string;
    state: string;
    creator?: string;
}

interface DatabricksProviderFormProps {
    connectedProvider?: ConnectedProvider;
    onConnect: (provider: ConnectedProvider) => void;
    onDisconnect: () => void;
    onModelChange: (modelId: string) => void;
    showModelError: boolean;
}

export function DatabricksProviderForm({
    connectedProvider,
    onConnect,
    onDisconnect,
    onModelChange,
    showModelError,
}: DatabricksProviderFormProps) {
    const [workspaceUrl, setWorkspaceUrl] = useState('');
    const [apiToken, setApiToken] = useState('');
    const [endpointName, setEndpointName] = useState('');
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [availableEndpoints, setAvailableEndpoints] = useState<DatabricksEndpoint[]>([]);

    const isConnected = connectedProvider?.connectionStatus === 'connected';

    // Load saved config on mount
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const accomplish = getAccomplish();
                const config = await accomplish.getDatabricksConfig();
                if (config) {
                    setWorkspaceUrl(config.workspaceUrl);
                    setEndpointName(config.endpointName);
                }
            } catch (err) {
                console.warn('Failed to load Databricks config:', err);
            }
        };
        loadConfig();
    }, []);

    const handleConnect = async () => {
        const trimmedUrl = workspaceUrl.trim();
        const trimmedToken = apiToken.trim();

        if (!trimmedUrl) {
            setError('Workspace URL is required');
            return;
        }
        if (!trimmedToken) {
            setError('API Token is required');
            return;
        }

        setConnecting(true);
        setError(null);

        try {
            const accomplish = getAccomplish();

            // Test connection and get available endpoints
            const result = await accomplish.testDatabricksConnection(trimmedUrl, trimmedToken);

            if (!result.success) {
                setError(result.error || 'Connection failed');
                setConnecting(false);
                return;
            }

            const endpoints = result.endpoints || [];
            setAvailableEndpoints(endpoints);

            // Save the config
            await accomplish.saveDatabricksConfig({
                workspaceUrl: trimmedUrl,
                endpointName: endpointName || (endpoints.length > 0 ? endpoints[0].name : ''),
                apiToken: trimmedToken,
            });

            const selectedEndpoint = endpointName || (endpoints.length > 0 ? endpoints[0].name : '');

            const provider: ConnectedProvider = {
                providerId: 'databricks',
                connectionStatus: 'connected',
                selectedModelId: selectedEndpoint ? `databricks/${selectedEndpoint}` : null,
                credentials: {
                    type: 'databricks',
                    workspaceUrl: trimmedUrl,
                    endpointName: selectedEndpoint,
                    keyPrefix: trimmedToken.substring(0, 8),
                } as DatabricksCredentials,
                lastConnectedAt: new Date().toISOString(),
                availableModels: endpoints.map((ep: DatabricksEndpoint) => ({
                    id: `databricks/${ep.name}`,
                    name: ep.name,
                    state: ep.state,
                })),
            };

            onConnect(provider);

            // Clear token from state after saving
            setApiToken('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Connection failed');
        } finally {
            setConnecting(false);
        }
    };

    const handleDisconnect = async () => {
        try {
            const accomplish = getAccomplish();
            await accomplish.setDatabricksConfig(null);
            setAvailableEndpoints([]);
            onDisconnect();
        } catch (err) {
            console.warn('Failed to clear Databricks config:', err);
            onDisconnect();
        }
    };

    // Build models list from connected provider or available endpoints
    const models = (connectedProvider?.availableModels || availableEndpoints.map((ep: DatabricksEndpoint) => ({
        id: `databricks/${ep.name}`,
        name: ep.name,
    })));

    return (
        <div className="rounded-xl border border-border bg-card p-5" data-testid="provider-settings-panel">
            <ProviderFormHeader logoSrc={databricksLogo} providerName="Databricks" />

            <div className="space-y-3">
                <AnimatePresence mode="wait">
                    {!isConnected ? (
                        <motion.div
                            key="disconnected"
                            variants={settingsVariants.fadeSlide}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={settingsTransitions.enter}
                            className="space-y-3"
                        >
                            <div>
                                <label className="mb-2 block text-sm font-medium text-foreground">
                                    Workspace URL
                                </label>
                                <input
                                    type="url"
                                    value={workspaceUrl}
                                    onChange={(e) => setWorkspaceUrl(e.target.value)}
                                    placeholder="https://adb-xxxxx.azuredatabricks.net"
                                    data-testid="databricks-workspace-url"
                                    className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Your Databricks workspace URL
                                </p>
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-foreground">
                                    Personal Access Token
                                </label>
                                <input
                                    type="password"
                                    value={apiToken}
                                    onChange={(e) => setApiToken(e.target.value)}
                                    placeholder="dapi..."
                                    data-testid="databricks-api-token"
                                    className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm font-mono"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Create a token in User Settings → Developer → Access tokens
                                </p>
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-foreground">
                                    Endpoint Name <span className="text-muted-foreground">(optional)</span>
                                </label>
                                <input
                                    type="text"
                                    value={endpointName}
                                    onChange={(e) => setEndpointName(e.target.value)}
                                    placeholder="Leave empty to discover endpoints"
                                    data-testid="databricks-endpoint-name"
                                    className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Serving endpoint name (will fetch available endpoints if empty)
                                </p>
                            </div>

                            <FormError error={error} />
                            <ConnectButton onClick={handleConnect} connecting={connecting} />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="connected"
                            variants={settingsVariants.fadeSlide}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            transition={settingsTransitions.enter}
                            className="space-y-3"
                        >
                            <div>
                                <label className="mb-2 block text-sm font-medium text-foreground">
                                    Workspace URL
                                </label>
                                <input
                                    type="text"
                                    value={(connectedProvider?.credentials as DatabricksCredentials)?.workspaceUrl || ''}
                                    disabled
                                    className="w-full rounded-md border border-input bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
                                />
                            </div>

                            <ConnectedControls onDisconnect={handleDisconnect} />

                            {models.length > 0 && (
                                <ModelSelector
                                    models={models}
                                    value={connectedProvider?.selectedModelId || null}
                                    onChange={onModelChange}
                                    error={showModelError && !connectedProvider?.selectedModelId}
                                    errorMessage="Please select an endpoint"
                                    placeholder="Select a serving endpoint..."
                                />
                            )}

                            <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-400">
                                <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <div>
                                    <p className="font-medium">Databricks Foundation Model API</p>
                                    <p className="text-blue-400/80 mt-1">
                                        Connected to your serving endpoint. Models are served via OpenAI-compatible API.
                                    </p>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
