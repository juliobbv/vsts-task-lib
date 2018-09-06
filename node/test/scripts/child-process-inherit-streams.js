var cp = require('child_process');
var fs = require('fs');

// get the command line args that use the format someArg=someValue
var args = {};
process.argv.forEach(function (arg) {
    var match = arg.match(/^(.+)=(.*)$/);
    if (match) {
        args[match[1]] = match[2];
    }
});

var nodePath = args.nodePath;
var isChild = args.isChild == 'true';

if (!nodePath) {
    throw new Error('nodePath is not specified');
}

if (!isChild) {
    var child = cp.spawn(
        nodePath,
        [
            __filename,
            `nodePath=${nodePath}`,
            'isChild=true'
        ],
        {
            stdio: "inherit"
        });
    child.unref();
    return;
}
else {
    fs.writeFileSync('C:\\temp\\z_begin.txt', (new Date(Date.now())).toString());
    setTimeout(function () {
        fs.writeFileSync('C:\\temp\\z_end.txt', (new Date(Date.now())).toString());
    },
    10000);
}
