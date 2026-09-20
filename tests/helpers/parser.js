export const UNPARSABLE = '/echo ((';

const broken = text => String(text).includes('((');

export function stubParser() {
    return text => (broken(text) ? 'unexpected end of closure' : '');
}

export function hostParserClass(onAdd) {
    return class StubSlashCommandParser {
        static addCommandObject(command) {
            onAdd(command);
        }

        parse(text) {
            if (broken(text)) {
                throw new Error('unexpected end of closure');
            }
        }
    };
}
