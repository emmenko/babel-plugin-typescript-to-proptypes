import { types as t } from '@babel/core';
import getTypeName from './getTypeName';
import { PropType } from './types';

function isReactTypeMatch(name: string, type: string, reactImportedName: string): boolean {
  return name === type || name === `React.${type}` || name === `${reactImportedName}.${type}`;
}

function wrapIsRequired(propType: PropType, optional?: boolean | null): PropType {
  return optional ? propType : t.memberExpression(propType, t.identifier('isRequired'));
}

function createCall(
  value: t.Identifier,
  args: (PropType | t.ArrayExpression | t.ObjectExpression)[],
): t.CallExpression {
  return t.callExpression(createMember(value), args);
}

function createMember(value: t.Identifier): t.MemberExpression {
  return t.memberExpression(t.identifier('PropTypes'), value);
}

function convert(type: any, reactImportedName: string): PropType | null {
  // Remove wrapping parens
  if (t.isTSParenthesizedType(type)) {
    type = type.typeAnnotation;
  }

  // string -> PropTypes.string
  if (t.isTSStringKeyword(type)) {
    return createMember(t.identifier('string'));

    // number -> PropTypes.number
  } else if (t.isTSNumberKeyword(type)) {
    return createMember(t.identifier('number'));

    // boolean -> PropTypes.bool
  } else if (t.isTSBooleanKeyword(type)) {
    return createMember(t.identifier('bool'));

    // symbol -> PropTypes.symbol
  } else if (t.isTSSymbolKeyword(type)) {
    return createMember(t.identifier('symbol'));

    // (() => void) -> PropTypes.func
  } else if (t.isTSFunctionType(type)) {
    return createMember(t.identifier('func'));

    // React.ReactNode -> PropTypes.node
    // React.ReactElement -> PropTypes.element
    // React.MouseEvent -> PropTypes.object
    // React.MouseEventHandler -> PropTypes.func
    // React.Ref -> PropTypes.oneOfType()
    // JSX.Element -> PropTypes.element
    // CustomType -> PropTypes.any TODO
  } else if (t.isTSTypeReference(type)) {
    const name = getTypeName(type.typeName);

    // node
    if (
      isReactTypeMatch(name, 'ReactText', reactImportedName) ||
      isReactTypeMatch(name, 'ReactNode', reactImportedName) ||
      isReactTypeMatch(name, 'ReactType', reactImportedName) ||
      isReactTypeMatch(name, 'ComponentType', reactImportedName) ||
      isReactTypeMatch(name, 'ComponentClass', reactImportedName) ||
      isReactTypeMatch(name, 'StatelessComponent', reactImportedName)
    ) {
      return createMember(t.identifier('node'));

      // element
    } else if (
      isReactTypeMatch(name, 'Element', 'JSX') ||
      isReactTypeMatch(name, 'ReactElement', reactImportedName) ||
      isReactTypeMatch(name, 'SFCElement', reactImportedName)
    ) {
      return createMember(t.identifier('element'));

      // oneOfType
    } else if (isReactTypeMatch(name, 'Ref', reactImportedName)) {
      return createCall(t.identifier('oneOfType'), [
        t.arrayExpression([
          createMember(t.identifier('string')),
          createMember(t.identifier('func')),
          createMember(t.identifier('object')),
        ]),
      ]);

      // func
    } else if (name.endsWith('Handler')) {
      return createMember(t.identifier('func'));

      // object
    } else if (name.endsWith('Event')) {
      return createMember(t.identifier('object'));
    }

    // [] -> PropTypes.arrayOf(), PropTypes.array
  } else if (t.isTSArrayType(type)) {
    const args = convertArray([type.elementType], reactImportedName);

    return args.length > 0
      ? createCall(t.identifier('arrayOf'), args)
      : createMember(t.identifier('array'));

    // {} -> PropTypes.object
    // { [key: string]: string } -> PropTypes.objectOf(PropTypes.string)
    // { foo: string } -> PropTypes.shape({ foo: PropTypes.string })
  } else if (t.isTSTypeLiteral(type)) {
    // object
    if (type.members.length === 0) {
      return createMember(t.identifier('object'));

      // objectOf
    } else if (type.members.length === 1 && t.isTSIndexSignature(type.members[0])) {
      const index = type.members[0] as t.TSIndexSignature;

      if (index.typeAnnotation && index.typeAnnotation.typeAnnotation) {
        const result = convert(index.typeAnnotation.typeAnnotation, reactImportedName);

        if (result) {
          return createCall(t.identifier('objectOf'), [result]);
        }
      }

      // shape
    } else {
      return createCall(t.identifier('shape'), [
        t.objectExpression(
          convertListToProps(
            type.members.filter(member =>
              t.isTSPropertySignature(member),
            ) as t.TSPropertySignature[],
            reactImportedName,
          ),
        ),
      ]);
    }

    // string | number -> PropTypes.oneOfType([PropTypes.string, PropTypes.number])
    // 'foo' | 'bar' -> PropTypes.oneOf(['foo', 'bar'])
  } else if (t.isTSUnionType(type) || t.isTSIntersectionType(type)) {
    const isAllLiterals = type.types.every(param => t.isTSLiteralType(param));
    let label;
    let args;

    if (isAllLiterals) {
      args = type.types.map(param => (param as t.TSLiteralType).literal);
      label = t.identifier('oneOf');
    } else {
      args = convertArray(type.types, reactImportedName);
      label = t.identifier('oneOfType');
    }

    if (label && args.length > 0) {
      return createCall(label, [t.arrayExpression(args)]);
    }
  }

  return null;
}

function convertArray(types: any[], reactImportedName: string): PropType[] {
  const propTypes: PropType[] = [];

  types.forEach(type => {
    const prop = convert(type, reactImportedName);

    if (prop) {
      propTypes.push(prop);
    }
  });

  return propTypes;
}

function convertListToProps(
  properties: t.TSPropertySignature[],
  reactImportedName: string,
): t.ObjectProperty[] {
  const propTypes: t.ObjectProperty[] = [];

  properties.forEach(property => {
    if (!property.typeAnnotation) {
      return;
    }

    const propType = convert(property.typeAnnotation.typeAnnotation, reactImportedName);

    if (propType) {
      propTypes.push(t.objectProperty(property.key, wrapIsRequired(propType, property.optional)));
    }
  });

  return propTypes;
}

export default function convertToPropTypes(
  types: { [key: string]: t.TSPropertySignature[] },
  typeNames: string[],
  reactImportedName: string,
): t.ObjectProperty[] {
  const properties: t.ObjectProperty[] = [];

  typeNames.forEach(typeName => {
    if (types[typeName]) {
      properties.push(...convertListToProps(types[typeName], reactImportedName));
    }
  });

  return properties;
}
