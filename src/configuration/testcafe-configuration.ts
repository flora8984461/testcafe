import Configuration from './configuration-base';
import { castArray, flatten } from 'lodash';
import { getGrepOptions, getSSLOptions } from '../utils/get-options';
import OPTION_NAMES from './option-names';
import getFilterFn from '../utils/get-filter-fn';
import prepareReporters from '../utils/prepare-reporters';
import { getConcatenatedValuesString, getPluralSuffix } from '../utils/string';
import renderTemplate from '../utils/render-template';
import WARNING_MESSAGES from '../notifications/warning-message';
import resolvePathRelativelyCwd from '../utils/resolve-path-relatively-cwd';

import {
    DEFAULT_APP_INIT_DELAY,
    DEFAULT_CONCURRENCY_VALUE,
    DEFAULT_SPEED_VALUE,
    DEFAULT_TIMEOUT,
    DEFAULT_SOURCE_DIRECTORIES,
    DEFAULT_DEVELOPMENT_MODE,
    DEFAULT_RETRY_TEST_PAGES,
    DEFAULT_DISABLE_HTTP2,
    DEFAULT_PROXYLESS,
    DEFAULT_SCREENSHOT_THUMBNAILS,
    getDefaultCompilerOptions,
} from './default-values';

import OptionSource from './option-source';
import {
    Dictionary,
    FilterOption,
    ReporterOption,
    TypeScriptCompilerOptions,
} from './interfaces';

import CustomizableCompilers from './customizable-compilers';
import { DEPRECATED, getDeprecationMessage } from '../notifications/deprecated';
import WarningLog from '../notifications/warning-log';
import browserProviderPool from '../browser/provider/pool';
import BrowserConnection, { BrowserInfo } from '../browser/connection';
import { CONFIGURATION_EXTENSIONS } from './formats';
import { GeneralError } from '../errors/runtime';
import { RUNTIME_ERRORS } from '../errors/types';

const BASE_CONFIGURATION_FILENAME = '.testcaferc';
const CONFIGURATION_FILENAMES     = CONFIGURATION_EXTENSIONS.map(ext => `${BASE_CONFIGURATION_FILENAME}${ext}`);

const DEFAULT_SCREENSHOTS_DIRECTORY = 'screenshots';

const OPTION_FLAG_NAMES = [
    OPTION_NAMES.skipJsErrors,
    OPTION_NAMES.debugMode,
    OPTION_NAMES.debugOnFail,
    OPTION_NAMES.skipUncaughtErrors,
    OPTION_NAMES.stopOnFirstFail,
    OPTION_NAMES.takeScreenshotsOnFails,
    OPTION_NAMES.disablePageCaching,
    OPTION_NAMES.disablePageReloads,
    OPTION_NAMES.disableScreenshots,
    OPTION_NAMES.disableMultipleWindows,
];

const OPTION_INIT_FLAG_NAMES = [
    OPTION_NAMES.developmentMode,
    OPTION_NAMES.retryTestPages,
    OPTION_NAMES.cache,
    OPTION_NAMES.disableHttp2,
    OPTION_NAMES.proxyless,
];

interface TestCafeAdditionalStartOptions {
    retryTestPages: boolean;
    ssl: string;
    developmentMode: boolean;
    cache: boolean;
    disableHttp2: boolean;
}

interface TestCafeStartOptions {
    hostname?: string;
    port1?: number;
    port2?: number;
    options: TestCafeAdditionalStartOptions;
}

type BrowserInfoSource = BrowserInfo | BrowserConnection;

export default class TestCafeConfiguration extends Configuration {
    protected readonly _isExplicitConfig: boolean;

    public constructor (configFile = '') {
        super(configFile || CONFIGURATION_FILENAMES);

        this._isExplicitConfig = !!configFile;
    }

    public async init (options?: object): Promise<void> {
        await super.init();

        const opts = await this._load();

        if (opts) {
            this._options = Configuration._fromObj(opts);

            await this._normalizeOptionsAfterLoad();
        }

        await this.asyncMergeOptions(options);
    }

    public async asyncMergeOptions (options?: object): Promise<void> {
        options = options || {};

        super.mergeOptions(options);

        if (this._options.browsers)
            this._options.browsers.value = await this._getBrowserInfo();
    }

    public prepare (): void {
        this._prepareFlags();
        this._setDefaultValues();
        this._prepareCompilerOptions();
    }

    public notifyAboutOverriddenOptions (): void {
        if (!this._overriddenOptions.length)
            return;

        const optionsStr    = getConcatenatedValuesString(this._overriddenOptions);
        const optionsSuffix = getPluralSuffix(this._overriddenOptions);

        Configuration._showConsoleWarning(renderTemplate(WARNING_MESSAGES.configOptionsWereOverridden, optionsStr, optionsSuffix));

        this._overriddenOptions = [];
    }

    public notifyAboutDeprecatedOptions (warningLog: WarningLog): void {
        const deprecatedOptions = this.getOptions((name, option) => name in DEPRECATED && option.value !== void 0);

        for (const optionName in deprecatedOptions)
            warningLog.addWarning(getDeprecationMessage(DEPRECATED[optionName]));
    }

    public get startOptions (): TestCafeStartOptions {
        const result: TestCafeStartOptions = {
            hostname: this.getOption(OPTION_NAMES.hostname) as string,
            port1:    this.getOption(OPTION_NAMES.port1) as number,
            port2:    this.getOption(OPTION_NAMES.port2) as number,

            options: {
                ssl:             this.getOption(OPTION_NAMES.ssl) as string,
                developmentMode: this.getOption(OPTION_NAMES.developmentMode) as boolean,
                retryTestPages:  this.getOption(OPTION_NAMES.retryTestPages) as boolean,
                cache:           this.getOption(OPTION_NAMES.cache) as boolean,
                disableHttp2:    this.getOption(OPTION_NAMES.disableHttp2) as boolean,
            },
        };

        return result;
    }

    private _prepareFlag (name: string): void {
        const option = this._ensureOption(name, void 0, OptionSource.Configuration);

        option.value = !!option.value;
    }

    private _prepareFlags (): void {
        OPTION_FLAG_NAMES.forEach(name => this._prepareFlag(name));
    }

    private _prepareInitFlags (): void {
        OPTION_INIT_FLAG_NAMES.forEach(name => this._prepareFlag(name));
    }

    private async _normalizeOptionsAfterLoad (): Promise<void> {
        await this._prepareSslOptions();
        this._prepareInitFlags();
        this._prepareFilterFn();
        this._ensureArrayOption(OPTION_NAMES.src);
        this._ensureArrayOption(OPTION_NAMES.browsers);
        this._ensureArrayOption(OPTION_NAMES.clientScripts);
        this._prepareReporters();
    }

    private _prepareFilterFn (): void {
        const filterOption = this._ensureOption(OPTION_NAMES.filter, null, OptionSource.Configuration);

        if (!filterOption.value)
            return;

        const filterOptionValue = filterOption.value as FilterOption;

        if (filterOptionValue.testGrep)
            filterOptionValue.testGrep = getGrepOptions(OPTION_NAMES.filterTestGrep, filterOptionValue.testGrep as string);

        if (filterOptionValue.fixtureGrep)
            filterOptionValue.fixtureGrep = getGrepOptions(OPTION_NAMES.filterFixtureGrep, filterOptionValue.fixtureGrep as string);

        filterOption.value = getFilterFn(filterOption.value) as Function;
    }

    private _ensureScreenshotOptions (): void {
        const path        = resolvePathRelativelyCwd(DEFAULT_SCREENSHOTS_DIRECTORY);
        const screenshots = this._ensureOption(OPTION_NAMES.screenshots, {}, OptionSource.Configuration).value as Dictionary<string|boolean>;

        if (!screenshots.path)
            screenshots.path = path;

        if (screenshots.thumbnails === void 0)
            screenshots.thumbnails = DEFAULT_SCREENSHOT_THUMBNAILS;
    }

    private _prepareReporters (): void {
        const reporterOption = this._options[OPTION_NAMES.reporter];

        if (!reporterOption)
            return;

        const optionValue = castArray(reporterOption.value as ReporterOption);

        reporterOption.value = prepareReporters(optionValue);
    }

    private async _prepareSslOptions (): Promise<void> {
        const sslOptions = this._options[OPTION_NAMES.ssl];

        if (!sslOptions)
            return;

        sslOptions.value = await getSSLOptions(sslOptions.value as string) as Dictionary<string | boolean | number>;
    }

    private _setDefaultValues (): void {
        this._ensureOptionWithValue(OPTION_NAMES.selectorTimeout, DEFAULT_TIMEOUT.selector, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.assertionTimeout, DEFAULT_TIMEOUT.assertion, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.pageLoadTimeout, DEFAULT_TIMEOUT.pageLoad, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.speed, DEFAULT_SPEED_VALUE, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.appInitDelay, DEFAULT_APP_INIT_DELAY, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.concurrency, DEFAULT_CONCURRENCY_VALUE, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.src, DEFAULT_SOURCE_DIRECTORIES, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.developmentMode, DEFAULT_DEVELOPMENT_MODE, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.retryTestPages, DEFAULT_RETRY_TEST_PAGES, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.disableHttp2, DEFAULT_DISABLE_HTTP2, OptionSource.Configuration);
        this._ensureOptionWithValue(OPTION_NAMES.proxyless, DEFAULT_PROXYLESS, OptionSource.Configuration);

        this._ensureScreenshotOptions();
    }

    private _prepareCompilerOptions (): void {
        const compilerOptions = this._ensureOption(OPTION_NAMES.compilerOptions, getDefaultCompilerOptions(), OptionSource.Configuration);

        compilerOptions.value = compilerOptions.value || getDefaultCompilerOptions();

        const tsConfigPath = this.getOption(OPTION_NAMES.tsConfigPath);

        if (tsConfigPath) {
            const compilerOptionValue     = compilerOptions.value as CompilerOptions;
            let typeScriptCompilerOptions = compilerOptionValue[CustomizableCompilers.typescript] as TypeScriptCompilerOptions;

            typeScriptCompilerOptions = Object.assign({
                configPath: tsConfigPath,
            }, typeScriptCompilerOptions);

            (compilerOptions.value as CompilerOptions)[CustomizableCompilers.typescript] = typeScriptCompilerOptions;
        }
    }

    private async _getBrowserInfo (): Promise<BrowserInfoSource[]> {
        if (!this._options.browsers.value)
            return [];

        const browsers = Array.isArray(this._options.browsers.value) ? [...this._options.browsers.value] : [this._options.browsers.value];

        const browserInfo = await Promise.all(browsers.map(browser => browserProviderPool.getBrowserInfo(browser)));

        return flatten(browserInfo);
    }

    protected async _isConfigurationFileExists (filePath = this.filePath): Promise<boolean> {
        const fileExists = await super._isConfigurationFileExists(filePath);

        if (!fileExists && this._isExplicitConfig)
            throw new GeneralError(RUNTIME_ERRORS.cannotFindTestcafeConfigurationFile, filePath);

        return fileExists;
    }

    public static get FILENAMES (): string[] {
        return CONFIGURATION_FILENAMES;
    }
}
