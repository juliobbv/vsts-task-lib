

import Q = require('q');
import os = require('os');
import events = require('events');
import child = require('child_process');
import stream = require('stream');
import im = require('./internal');
import tcm = require('./taskcommand');
import fs = require('fs');

/**
 * Interface for exec options
 */
export interface IExecOptions extends IExecSyncOptions {
    /** optional.  whether to fail if output to stderr.  defaults to false */
    failOnStdErr: boolean;

    /** optional.  defaults to failing on non zero.  ignore will not fail leaving it up to the caller */
    ignoreReturnCode: boolean;
};

/**
 * Interface for execSync options
 */
export interface IExecSyncOptions {
    /** optional working directory.  defaults to current */
    cwd: string;

    /** optional envvar dictionary.  defaults to current process's env */
    env: { [key: string]: string };

    /** optional.  defaults to fales */
    silent: boolean;

    outStream: stream.Writable;

    errStream: stream.Writable;

    /** optional.  foo.whether to skip quoting/escaping arguments if needed.  defaults to false. */
    windowsVerbatimArguments: boolean;
};

/**
 * Interface for exec results returned from synchronous exec functions
 */
export interface IExecSyncResult {
    /** standard output */
    stdout: string;

    /** error output */
    stderr: string;

    /** return code */
    code: number;

    /** Error on failure */
    error: Error;
}

export class ToolRunner extends events.EventEmitter {
    constructor(toolPath) {
        super();

        if (!toolPath) {
            throw new Error('Parameter \'toolPath\' cannot be null or empty.');
        }

        this.toolPath = im._which(toolPath, true);
        this.args = [];
        this._debug('toolRunner toolPath: ' + toolPath);
    }

    private toolPath: string;
    private args: string[];
    private pipeOutputToTool: ToolRunner;
    private pipeOutputToFile: string;

    private _debug(message) {
        this.emit('debug', message);
    }

    private _argStringToArray(argString: string): string[] {
        var args = [];

        var inQuotes = false;
        var escaped = false;
        var arg = '';

        var append = function (c) {
            // we only escape double quotes.
            if (escaped && c !== '"') {
                arg += '\\';
            }

            arg += c;
            escaped = false;
        }

        for (var i = 0; i < argString.length; i++) {
            var c = argString.charAt(i);

            if (c === '"') {
                if (!escaped) {
                    inQuotes = !inQuotes;
                }
                else {
                    append(c);
                }
                continue;
            }

            if (c === "\\" && inQuotes) {
                escaped = true;
                continue;
            }

            if (c === ' ' && !inQuotes) {
                if (arg.length > 0) {
                    args.push(arg);
                    arg = '';
                }
                continue;
            }

            append(c);
        }

        if (arg.length > 0) {
            args.push(arg.trim());
        }

        return args;
    }

    private _getCommandString(options: IExecOptions, noPrefix?: boolean): string {
        let toolPath: string = this._getSpawnFileName();
        let args: string[] = this._getSpawnArgs(options);
        let cmd = noPrefix ? '' : '[command]'; // omit prefix when piped to a second tool
        if (process.platform == 'win32') {
            // Windows + cmd file
            if (this._isCmdFile()) {
                cmd += toolPath;
                args.forEach((a: string): void => {
                    cmd += ` ${a}`;
                });
            }
            // Windows + verbatim
            else if (options.windowsVerbatimArguments) {
                cmd += `"${toolPath}"`;
                args.forEach((a: string): void => {
                    cmd += ` ${a}`;
                });
            }
            // Windows (regular)
            else {
                cmd += this._windowsQuoteCmdArg(toolPath);
                args.forEach((a: string): void => {
                    cmd += ` ${this._windowsQuoteCmdArg(a)}`;
                });
            }
        }
        else {
            // OSX/Linux - this can likely be improved with some form of quoting.
            // creating processes on Unix is fundamentally different than Windows.
            // on Unix, execvp() takes an arg array.
            cmd += toolPath;
            args.forEach((a: string): void => {
                cmd += ` ${a}`;
            });
        }

        // append second tool
        if (this.pipeOutputToTool) {
            cmd += ' | ' + this.pipeOutputToTool._getCommandString(options, /*noPrefix:*/true);
        }

        return cmd;
    }

    private _processLineBuffer(data: Buffer, strBuffer: string, onLine: (line: string) => void): void {
        try {
            var s = strBuffer + data.toString();
            var n = s.indexOf(os.EOL);

            while (n > -1) {
                var line = s.substring(0, n);
                onLine(line);

                // the rest of the string ...
                s = s.substring(n + os.EOL.length);
                n = s.indexOf(os.EOL);
            }

            strBuffer = s;
        }
        catch (err) {
            // streaming lines to console is best effort.  Don't fail a build.
            this._debug('error processing line');
        }

    }

    private _getSpawnFileName(): string {
        if (process.platform == 'win32') {
            if (this._isCmdFile()) {
                return process.env['COMSPEC'] || 'cmd.exe';
            }
        }

        return this.toolPath;
    }

    private _getSpawnArgs(options: IExecOptions): string[] {
        if (process.platform == 'win32') {
            if (this._isCmdFile()) {
                let argline: string = `/D /S /C "${this._windowsQuoteCmdArg(this.toolPath)}`;
                for (let i = 0; i < this.args.length; i++) {
                    argline += ' ';
                    argline += options.windowsVerbatimArguments ? this.args[i] : this._windowsQuoteCmdArg(this.args[i]);
                }

                argline += '"';
                return [argline];
            }

            if (options.windowsVerbatimArguments) {
                // note, in Node 6.x options.argv0 can be used instead of overriding args.slice and args.unshift.
                // for more details, refer to https://github.com/nodejs/node/blob/v6.x/lib/child_process.js

                let args = this.args.slice(0); // copy the array

                // override slice to prevent Node from creating a copy of the arg array.
                // we need Node to use the "unshift" override below.
                args.slice = function () {
                    if (arguments.length != 1 || arguments[0] != 0) {
                        throw new Error('Unexpected arguments passed to args.slice when windowsVerbatimArguments flag is set.');
                    }

                    return args;
                };

                // override unshift
                //
                // when using the windowsVerbatimArguments option, Node does not quote the tool path when building
                // the cmdline parameter for the win32 function CreateProcess(). an unquoted space in the tool path
                // causes problems for tools when attempting to parse their own command line args. tools typically
                // assume their arguments begin after arg 0.
                //
                // by hijacking unshift, we can quote the tool path when it pushed onto the args array. Node builds
                // the cmdline parameter from the args array.
                //
                // note, we can't simply pass a quoted tool path to Node for multiple reasons:
                //   1) Node verifies the file exists (calls win32 function GetFileAttributesW) and the check returns
                //      false if the path is quoted.
                //   2) Node passes the tool path as the application parameter to CreateProcess, which expects the
                //      path to be unquoted.
                //
                // also note, in addition to the tool path being embedded within the cmdline parameter, Node also
                // passes the tool path to CreateProcess via the application parameter (optional parameter). when
                // present, Windows uses the application parameter to determine which file to run, instead of
                // interpreting the file from the cmdline parameter.
                args.unshift = function () {
                    if (arguments.length != 1) {
                        throw new Error('Unexpected arguments passed to args.unshift when windowsVerbatimArguments flag is set.');
                    }

                    return Array.prototype.unshift.call(args, `"${arguments[0]}"`); // quote the file name
                };
                return args;
            }
        }

        return this.args;
    }

    private _isCmdFile(): boolean {
        let upperToolPath: string = this.toolPath.toUpperCase();
        return im._endsWith(upperToolPath, '.CMD') || im._endsWith(upperToolPath, '.BAT');
    }

    private _windowsQuoteCmdArg(arg: string): string {
        // for .exe, apply the normal quoting rules that libuv applies
        if (!this._isCmdFile()) {
            return this._uv_quote_cmd_arg(arg);
        }

        // otherwise apply quoting rules specific to the cmd.exe command line parser.
        // the libuv rules are generic and are not designed specifically for cmd.exe
        // command line parser.
        //
        // for a detailed description of the cmd.exe command line parser, refer to
        // http://stackoverflow.com/questions/4094699/how-does-the-windows-command-interpreter-cmd-exe-parse-scripts/7970912#7970912

        // need quotes for empty arg
        if (!arg) {
            return '""';
        }

        // determine whether the arg needs to be quoted
        const cmdSpecialChars = [' ', '\t', '&', '(', ')', '[', ']', '{', '}', '^', '=', ';', '!', '\'', '+', ',', '`', '~', '|', '<', '>', '"'];
        let needsQuotes = false;
        for (let char of arg) {
            if (cmdSpecialChars.some(x => x == char)) {
                needsQuotes = true;
                break;
            }
        }

        // short-circuit if quotes not needed
        if (!needsQuotes) {
            return arg;
        }

        // the following quoting rules are very similar to the rules that by libuv applies.
        //
        // 1) wrap the string in quotes
        //
        // 2) double-up quotes - i.e. " => ""
        //
        //    this is different from the libuv quoting rules. libuv replaces " with \", which unfortunately
        //    doesn't work well with a cmd.exe command line.
        //
        //    note, replacing " with "" also works well if the arg is passed to a downstream .NET console app.
        //    for example, the command line:
        //          foo.exe "myarg:""my val"""
        //    is parsed by a .NET console app into an arg array:
        //          [ "myarg:\"my val\"" ]
        //    which is the same end result when applying libuv quoting rules. although the actual
        //    command line from libuv quoting rules would look like:
        //          foo.exe "myarg:\"my val\""
        //
        // 3) double-up slashes that preceed a quote,
        //    e.g.  hello \world    => "hello \world"
        //          hello\"world    => "hello\\""world"
        //          hello\\"world   => "hello\\\\""world"
        //          hello world\    => "hello world\\"
        //
        //    technically this is not required for a cmd.exe command line, or the batch argument parser.
        //    the reasons for including this as a .cmd quoting rule are:
        //
        //    a) this is optimized for the scenario where the argument is passed from the .cmd file to an
        //       external program. many programs (e.g. .NET console apps) rely on the slash-doubling rule.
        //
        //    b) it's what we've been doing previously (by deferring to node default behavior) and we
        //       haven't heard any complaints about that aspect.
        //
        // note, a weakness of the quoting rules chosen here, is that % is not escaped. in fact, % cannot be
        // escaped when used on the command line directly - even though within a .cmd file % can be escaped
        // by using %%.
        //
        // the saving grace is, on the command line, %var% is left as-is if var is not defined. this contrasts
        // the line parsing rules within a .cmd file, where if var is not defined it is replaced with nothing.
        //
        // one option that was explored was replacing % with ^% - i.e. %var% => ^%var^%. this hack would
        // often work, since it is unlikely that var^ would exist, and the ^ character is removed when the
        // variable is used. the problem, however, is that ^ is not removed when %* is used to pass the args
        // to an external program.
        //
        // an unexplored potential solution for the % escaping problem, is to create a wrapper .cmd file.
        // % can be escaped within a .cmd file.
        let reverse: string = '"';
        let quote_hit = true;
        for (let i = arg.length; i > 0; i--) { // walk the string in reverse
            reverse += arg[i - 1];
            if (quote_hit && arg[i - 1] == '\\') {
                reverse += '\\'; // double the slash
            }
            else if (arg[i - 1] == '"') {
                quote_hit = true;
                reverse += '"'; // double the quote
            }
            else {
                quote_hit = false;
            }
        }

        reverse += '"';
        return reverse.split('').reverse().join('');
    }

    private _uv_quote_cmd_arg(arg: string): string {
        // Tool runner wraps child_process.spawn() and needs to apply the same quoting as
        // Node in certain cases where the undocumented spawn option windowsVerbatimArguments
        // is used.
        //
        // Since this function is a port of quote_cmd_arg from Node 4.x (technically, lib UV,
        // see https://github.com/nodejs/node/blob/v4.x/deps/uv/src/win/process.c for details),
        // pasting copyright notice from Node within this function:
        //
        //      Copyright Joyent, Inc. and other Node contributors. All rights reserved.
        //
        //      Permission is hereby granted, free of charge, to any person obtaining a copy
        //      of this software and associated documentation files (the "Software"), to
        //      deal in the Software without restriction, including without limitation the
        //      rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
        //      sell copies of the Software, and to permit persons to whom the Software is
        //      furnished to do so, subject to the following conditions:
        //
        //      The above copyright notice and this permission notice shall be included in
        //      all copies or substantial portions of the Software.
        //
        //      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        //      IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        //      FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        //      AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        //      LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
        //      FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
        //      IN THE SOFTWARE.

        if (!arg) {
            // Need double quotation for empty argument
            return '""';
        }

        if (arg.indexOf(' ') < 0 && arg.indexOf('\t') < 0 && arg.indexOf('"') < 0) {
            // No quotation needed
            return arg;
        }

        if (arg.indexOf('"') < 0 && arg.indexOf('\\') < 0) {
            // No embedded double quotes or backslashes, so I can just wrap
            // quote marks around the whole thing.
            return `"${arg}"`;
        }

        // Expected input/output:
        //   input : hello"world
        //   output: "hello\"world"
        //   input : hello""world
        //   output: "hello\"\"world"
        //   input : hello\world
        //   output: hello\world
        //   input : hello\\world
        //   output: hello\\world
        //   input : hello\"world
        //   output: "hello\\\"world"
        //   input : hello\\"world
        //   output: "hello\\\\\"world"
        //   input : hello world\
        //   output: "hello world\\" - note the comment in libuv actually reads "hello world\"
        //                             but it appears the comment is wrong, it should be "hello world\\"
        let reverse: string = '"';
        let quote_hit = true;
        for (let i = arg.length; i > 0; i--) { // walk the string in reverse
            reverse += arg[i - 1];
            if (quote_hit && arg[i - 1] == '\\') {
                reverse += '\\';
            }
            else if (arg[i - 1] == '"') {
                quote_hit = true;
                reverse += '\\';
            }
            else {
                quote_hit = false;
            }
        }

        reverse += '"';
        return reverse.split('').reverse().join('');
    }

    private _cloneExecOptions(options: IExecOptions): IExecOptions {
        options = options || <IExecOptions>{};
        let result: IExecOptions = <IExecOptions>{
            cwd: options.cwd || process.cwd(),
            env: options.env || process.env,
            silent: options.silent || false,
            failOnStdErr: options.failOnStdErr || false,
            ignoreReturnCode: options.ignoreReturnCode || false,
            windowsVerbatimArguments: options.windowsVerbatimArguments || false
        };
        result.outStream = options.outStream || <stream.Writable>process.stdout;
        result.errStream = options.errStream || <stream.Writable>process.stderr;
        return result;
    }

    private _getSpawnOptions(options: IExecOptions): child.SpawnOptions {
        let result = <child.SpawnOptions>{};
        result.cwd = options.cwd;
        result.env = options.env;
        result['windowsVerbatimArguments'] = options.windowsVerbatimArguments || this._isCmdFile();
        return result;
    }

    private _getSpawnSyncOptions(options: IExecSyncOptions): child.SpawnSyncOptions {
        let result = <child.SpawnSyncOptions>{};
        result.cwd = options.cwd;
        result.env = options.env;
        result['windowsVerbatimArguments'] = options.windowsVerbatimArguments || this._isCmdFile();
        return result;
    }

    /**
     * Add argument
     * Append an argument or an array of arguments 
     * returns ToolRunner for chaining
     * 
     * @param     val        string cmdline or array of strings
     * @returns   ToolRunner
     */
    public arg(val: string | string[]): ToolRunner {
        if (!val) {
            return;
        }

        if (val instanceof Array) {
            this._debug(this.toolPath + ' arg: ' + JSON.stringify(val));
            this.args = this.args.concat(val);
        }
        else if (typeof (val) === 'string') {
            this._debug(this.toolPath + ' arg: ' + val);
            this.args = this.args.concat(val.trim());
        }

        return this;
    }

    /**
     * Parses an argument line into one or more arguments
     * e.g. .line('"arg one" two -z') is equivalent to .arg(['arg one', 'two', '-z'])
     * returns ToolRunner for chaining
     * 
     * @param     val        string argument line
     * @returns   ToolRunner
     */
    public line(val: string): ToolRunner {
        if (!val) {
            return;
        }

        this._debug(this.toolPath + ' arg: ' + val);
        this.args = this.args.concat(this._argStringToArray(val));
        return this;
    }

    /**
     * Add argument(s) if a condition is met
     * Wraps arg().  See arg for details
     * returns ToolRunner for chaining
     *
     * @param     condition     boolean condition
     * @param     val     string cmdline or array of strings
     * @returns   ToolRunner
     */
    public argIf(condition: any, val: any) {
        if (condition) {
            this.arg(val);
        }
        return this;
    }

    /**
     * Pipe output of exec() to another tool
     * @param tool
     * @param file  optional filename to additionally stream the output to.
     * @returns {ToolRunner}
     */
    public pipeExecOutputToTool(tool: ToolRunner, file?: string): ToolRunner {
        this.pipeOutputToTool = tool;
        this.pipeOutputToFile = file;
        return this;
    }

    /**
     * Exec a tool.
     * Output will be streamed to the live console.
     * Returns promise with return code
     * 
     * @param     tool     path to tool to exec
     * @param     options  optional exec options.  See IExecOptions
     * @returns   number
     */
    public exec(options?: IExecOptions): Q.Promise<number> {
        var defer = Q.defer<number>();

        this._debug('exec tool: ' + this.toolPath);
        this._debug('arguments:');
        this.args.forEach((arg) => {
            this._debug('   ' + arg);
        });

        options = this._cloneExecOptions(options);
        if (!options.silent) {
            options.outStream.write(this._getCommandString(options) + os.EOL);
        }

        if (this.pipeOutputToTool) {
            // Following node documentation example from this link on how to pipe output of one process to another
            // https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options

            let state = new ExecState(this._debug, defer, options, this.toolPath, this.pipeOutputToTool.toolPath, this.pipeOutputToFile);

            // start the child process for both tools
            let cp1 = child.spawn(
                this._getSpawnFileName(),
                this._getSpawnArgs(options),
                this._getSpawnOptions(options));

            let cp2 = child.spawn(
                this.pipeOutputToTool._getSpawnFileName(),
                this.pipeOutputToTool._getSpawnArgs(options),
                this.pipeOutputToTool._getSpawnOptions(options));

            let fileStream = this.pipeOutputToFile ? fs.createWriteStream(this.pipeOutputToFile) : null;
            if (fileStream) {
                fileStream.on('finish', () => {
                    state.fileClosed = true;
                    this._debug(`Finished writing file '${this.pipeOutputToFile}'`);
                    fileStream = null;
                    state.CheckComplete();
                });

                fileStream.on('error', (err) => {
                    state.fileClosed = true;
                    this._debug(`Failed to pipe output of '${this.toolPath}' to file '${this.pipeOutputToFile}'. Error: ${err}`);
                    fileStream = null;
                    state.CheckComplete();
                })
            }

            // pipe stdout of first tool to stdin of second tool
            let fileStreamError: boolean;
            let stdinError: boolean;
            cp1.stdout.on('data', (data: Buffer) => {
                if (fileStream && !fileStreamError) {
                    try {
                        fileStream.write(data);
                    }
                    catch (err) {
                        fileStreamError = true;
                        this._debug(`Failed to pipe the output of '${this.toolPath}' to the file '${this.pipeOutputToFile}'. Error: ${err}`);
                    }
                }

                if (!stdinError) {
                    try {
                        cp2.stdin.write(data);
                    }
                    catch (err) {
                        stdinError = true;
                        this._debug(`Failed to pipe the output of '${this.toolPath}' to '${this.pipeOutputToTool.toolPath}'. The tool '${this.pipeOutputToTool.toolPath}' might have exited due to errors. Verify the arguments passed are valid. Error: ${err}`);
                    }
                }
            });

            cp1.stderr.on('data', (data: Buffer) => {
                state.processStderr = true;

                if (fileStream && !fileStreamError) {
                    try {
                        fileStream.write(data);
                    }
                    catch (err) {
                        fileStreamError = true;
                        this._debug(`Failed to pipe the output of '${this.toolPath}' to the file '${this.pipeOutputToFile}'. Error: ${err}`);
                    }
                }

                if (!options.silent) {
                    var s = options.failOnStdErr ? options.errStream : options.outStream;
                    s.write(data);
                }
            });

            cp1.on('error', (err) => {
                state.processError = err.message;
                state.processExited = true;
                state.processClosed = true;

                if (fileStream) {
                    fileStream.end();
                }

                cp2.stdin.end();
                state.CheckComplete();
            });

            cp1.on('exit', (code, signal) => {
                state.processExitCode = code;
                state.processExited = true;
                this._debug(`Exit code ${code} received from tool '${this.toolPath}'`);
                state.CheckComplete()
            });

            cp1.on('close', (code, signal) => {
                state.processExitCode = code;
                state.processExited = true;
                state.processClosed = true;

                if (fileStream) {
                    fileStream.end();
                }

                cp2.stdin.end();
                state.CheckComplete();
            });

            var stdbuffer: string = '';
            cp2.stdout.on('data', (data: Buffer) => {
                this.emit('stdout', data);

                if (!options.silent) {
                    options.outStream.write(data);
                }

                this._processLineBuffer(data, stdbuffer, (line: string) => {
                    this.emit('stdline', line);
                });
            });

            var errbuffer: string = '';
            cp2.stderr.on('data', (data: Buffer) => {
                state.process2Stderr = true;
                this.emit('stderr', data);

                if (!options.silent) {
                    var s = options.failOnStdErr ? options.errStream : options.outStream;
                    s.write(data);
                }

                this._processLineBuffer(data, errbuffer, (line: string) => {
                    this.emit('errline', line);
                });
            });

            cp2.on('error', (err) => {
                state.process2Error = err.message;
                state.process2Exited = true;
                state.process2Closed = true;
                state.CheckComplete();
            });

            cp2.on('exit', (code, signal) => {
                state.process2ExitCode = code;
                state.process2Exited = true;
                this._debug(`Exit code ${code} received from tool '${this.pipeOutputToTool.toolPath}'`);
                state.CheckComplete()
            });

            cp2.on('close', (code, signal) => {
                state.process2ExitCode = code;
                state.process2Exited = true;
                state.process2Closed = true;
                this._debug(`STDIO streams have closed for tool '${this.pipeOutputToTool.toolPath}'`)

                if (stdbuffer.length > 0) {
                    this.emit('stdline', stdbuffer);
                }

                if (errbuffer.length > 0) {
                    this.emit('errline', errbuffer);
                }

                state.CheckComplete();
            });
        } else {
            let state = new ExecState(this._debug, defer, options, this.toolPath);

            let cp = child.spawn(this._getSpawnFileName(), this._getSpawnArgs(options), this._getSpawnOptions(options));

            var stdbuffer: string = '';
            cp.stdout.on('data', (data: Buffer) => {
                this.emit('stdout', data);

                if (!options.silent) {
                    options.outStream.write(data);
                }

                this._processLineBuffer(data, stdbuffer, (line: string) => {
                    this.emit('stdline', line);
                });
            });

            var errbuffer: string = '';
            cp.stderr.on('data', (data: Buffer) => {
                state.processStderr = true;
                this.emit('stderr', data);

                if (!options.silent) {
                    var s = options.failOnStdErr ? options.errStream : options.outStream;
                    s.write(data);
                }

                this._processLineBuffer(data, errbuffer, (line: string) => {
                    this.emit('errline', line);
                });
            });

            cp.on('error', (err) => {
                state.processError = err.message;
                state.processExited = true;
                state.processClosed = true;
                state.CheckComplete();
            });

            cp.on('exit', (code, signal) => {
                state.processExitCode = code;
                state.processExited = true;
                this._debug(`Exit code ${code} received from tool '${this.toolPath}'`);
                state.CheckComplete()
            });

            cp.on('close', (code, signal) => {
                state.processExitCode = code;
                state.processExited = true;
                state.processClosed = true;
                this._debug(`STDIO streams have closed for tool '${this.toolPath}'`)

                if (stdbuffer.length > 0) {
                    this.emit('stdline', stdbuffer);
                }

                if (errbuffer.length > 0) {
                    this.emit('errline', errbuffer);
                }

                state.CheckComplete();
            });
        }

        return <Q.Promise<number>>defer.promise;
    }

    /**
     * Exec a tool synchronously. 
     * Output will be *not* be streamed to the live console.  It will be returned after execution is complete.
     * Appropriate for short running tools 
     * Returns IExecSyncResult with output and return code
     * 
     * @param     tool     path to tool to exec
     * @param     options  optional exec options.  See IExecSyncOptions
     * @returns   IExecSyncResult
     */
    public execSync(options?: IExecSyncOptions): IExecSyncResult {
        var defer = Q.defer();

        this._debug('exec tool: ' + this.toolPath);
        this._debug('arguments:');
        this.args.forEach((arg) => {
            this._debug('   ' + arg);
        });

        var success = true;
        options = this._cloneExecOptions(options as IExecOptions);

        if (!options.silent) {
            options.outStream.write(this._getCommandString(options as IExecOptions) + os.EOL);
        }

        var r = child.spawnSync(this._getSpawnFileName(), this._getSpawnArgs(options as IExecOptions), this._getSpawnSyncOptions(options));

        if (!options.silent && r.stdout && r.stdout.length > 0) {
            options.outStream.write(r.stdout);
        }

        if (!options.silent && r.stderr && r.stderr.length > 0) {
            options.errStream.write(r.stderr);
        }

        var res: IExecSyncResult = <IExecSyncResult>{ code: r.status, error: r.error };
        res.stdout = (r.stdout) ? r.stdout.toString() : null;
        res.stderr = (r.stderr) ? r.stderr.toString() : null;
        return res;
    }
}

class ExecState {
    constructor(
        debug: (any),
        defer: Q.Deferred<number>,
        options: IExecOptions,
        toolPath: string,
        toolPath2?: string,
        filePath?: string) {

        if (!toolPath) {
            throw new Error('toolPath must not be empty');
        }

        if (!toolPath2 && filePath) {
            throw new Error('filePath must not be supplied when toolPath2 is empty');
        }

        this.debug = debug;
        this.defer = defer;
        this.options = options;
        this.toolPath = toolPath;
        this.toolPath2 = toolPath2;
        this.filePath = filePath;
        let delay = process.env['TASKLIB_TEST_TOOLRUNNER_EXITDELAY'];
        if (delay) {
            this.delay = parseInt(delay);
        }
    }

    fileClosed: boolean; // tracks whether the file has closed
    processClosed: boolean; // tracks whether the process has exited and stdio is closed
    processError: string;
    processExitCode: number;
    processExited: boolean; // tracks whether the process has exited
    processStderr: boolean; // tracks whether stderr was written to
    process2Closed: boolean;
    process2Error: string;
    process2ExitCode: number;
    process2Exited: boolean;
    process2Stderr: boolean;
    private delay = 10; // seconds
    private debug: (any);
    private defer: Q.Deferred<number>;
    private done: boolean;
    private filePath: string;
    private options: IExecOptions;
    private toolPath: string;
    private toolPath2: string;
    private timeouts = [];

    public CheckComplete(): void {
        if (this.done) {
            return;
        }

        if (this.filePath && !this.fileClosed) {
            return;
        }

        if (this.toolPath2) {
            if (this.processClosed && this.process2Closed) {
                this._setResult();
            }
            else if (this.processExited && this.process2Exited) {
                this.timeouts.push(setTimeout(ExecState.HandleTimeout, this.delay * 1000, this));
            }
        }
        else {
            if (this.processClosed) {
                this._setResult();
            }
            else if (this.processExited) {
                this.timeouts.push(setTimeout(ExecState.HandleTimeout, this.delay * 1000, this));
            }
        }
    }

    private _setResult(): void {
        // determine whether there is an error
        let error: Error;
        if (this.processExited) {
            if (this.processError) {
                error = new Error(im._loc('LIB_ProcessError', this.toolPath, this.processError));
            }
            else if (this.processExitCode != 0 && !this.options.ignoreReturnCode) {
                error = new Error(im._loc('LIB_ProcessExitCode', this.toolPath, this.processExitCode));
            }
            else if (this.processStderr && this.options.failOnStdErr) {
                error = new Error(im._loc('LIB_ProcessStderr', this.toolPath));
            }
        }

        if (!error && this.toolPath2) {
            if (this.process2Error) {
                error = new Error(im._loc('LIB_ProcessError', this.toolPath2, this.process2Error));
            }
            else if (this.process2ExitCode != 0 && !this.options.ignoreReturnCode) {
                error = new Error(im._loc('LIB_ProcessExitCode', this.toolPath2, this.process2ExitCode));
            }
            else if (this.process2Stderr && this.options.failOnStdErr) {
                error = new Error(im._loc('LIB_ProcessStderr', this.toolPath2));
            }
        }

        // satisfy the promise
        if (error) {
            this.defer.reject(error);
        }
        else if (this.toolPath2) {
            this.defer.resolve(this.process2ExitCode);
        }
        else {
            this.defer.resolve(this.processExitCode);
        }

        // clear the timeouts
        while (this.timeouts.length > 0) {
            clearTimeout(this.timeouts.pop());
        }

        this.done = true;
    }

    private static HandleTimeout(state: ExecState) {
        if (state.done) {
            return;
        }

        if (!state.process2Closed && state.process2Exited) {
            state.debug(`The STDIO streams did not close within ${state.delay} seconds of the exit event from process '${state.toolPath2}'. This may indicate child processes the inherited the STDIO streams and the child processes have not yet exited.`);
        }

        if (!state.processClosed && state.processExited) {
            state.debug(`The STDIO streams did not close within ${state.delay} seconds of the exit event from process '${state.toolPath}'. This may indicate child processes the inherited the STDIO streams and the child processes have not yet exited.`);
        }

        state._setResult();
    }
}
