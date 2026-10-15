using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using MassiveScale.Testing;

var assembly = typeof(Matrix.Client.MatrixClient).Assembly;

if (args is ["--framework-names", var directory])
{
    return ListFrameworkNames(assembly, directory);
}

// Every model and enum of the matrix client, through the client's own serializer settings.
var (checkedTypes, failures) = ContractSmoke.Check(assembly);
foreach (var failure in failures)
{
    Console.Error.WriteLine(failure);
}

Console.WriteLine($"{checkedTypes.Count} models and enums checked, {failures.Count} failed.");
return failures.Count == 0 ? 0 : 1;

/// <summary>
/// Returns C# source with the text of every string and character literal removed, keeping the
/// holes of interpolated strings and all comments, so a word that is only data (the <c>"Cookie"</c>
/// header name) is not taken for a type the code names.
/// </summary>
static string WithoutLiteralText(string source)
{
    var output = new StringBuilder(source.Length);
    var i = 0;
    Code(source, ref i, output, inHole: false);
    return output.ToString();
}

/// <summary>
/// Copies code from <paramref name="i"/> to <paramref name="output"/>, dropping literal text, until
/// the end of the source or, inside an interpolation hole, the brace that closes it.
/// </summary>
static void Code(string source, ref int i, StringBuilder output, bool inHole)
{
    var depth = 0;
    while (i < source.Length)
    {
        var c = source[i];
        var next = i + 1 < source.Length ? source[i + 1] : '\0';
        if (c == '/' && next == '/')
        {
            var end = source.IndexOf('\n', i);
            end = end < 0 ? source.Length : end;
            output.Append(source, i, end - i);
            i = end;
        }
        else if (c == '/' && next == '*')
        {
            var end = source.IndexOf("*/", i + 2, StringComparison.Ordinal);
            end = end < 0 ? source.Length : end + 2;
            output.Append(source, i, end - i);
            i = end;
        }
        else if (c == '\'')
        {
            i++;
            while (i < source.Length && source[i] != '\'') i += source[i] == '\\' ? 2 : 1;
            i++;
            output.Append("''");
        }
        else if (c == '"' || (c is '$' or '@' && (next == '"' || (next is '$' or '@' && i + 2 < source.Length && source[i + 2] == '"'))))
        {
            var interpolated = false;
            var verbatim = false;
            while (source[i] != '"')
            {
                interpolated |= source[i] == '$';
                verbatim |= source[i] == '@';
                i++;
            }

            i++;
            output.Append('"');
            StringText(source, ref i, output, interpolated, verbatim);
            output.Append('"');
        }
        else
        {
            if (c == '{') depth++;
            if (c == '}' && depth-- == 0 && inHole) return;
            output.Append(c);
            i++;
        }
    }
}

/// <summary>
/// Skips the text of a string literal whose opening quote has been read, copying only its
/// interpolation holes, and stops after the closing quote.
/// </summary>
static void StringText(string source, ref int i, StringBuilder output, bool interpolated, bool verbatim)
{
    while (i < source.Length)
    {
        var c = source[i];
        var next = i + 1 < source.Length ? source[i + 1] : '\0';
        if (c == '"' && verbatim && next == '"')
        {
            i += 2;
        }
        else if (c == '"')
        {
            i++;
            return;
        }
        else if (c == '\\' && !verbatim)
        {
            i += 2;
        }
        else if (interpolated && c == '{' && next == '{')
        {
            i += 2;
        }
        else if (interpolated && c == '{')
        {
            i++;
            output.Append('{');
            Code(source, ref i, output, inHole: true);
            output.Append('}');
            i++;
        }
        else
        {
            i++;
        }
    }
}

/// <summary>
/// Prints every framework type the generated C# in a directory names without qualification:
/// each public type of a namespace the files import whose simple name (or, for an attribute,
/// the name without <c>Attribute</c>) appears as a word in them. One line each:
/// <c>name arity namespace</c>.
/// </summary>
static int ListFrameworkNames(Assembly generated, string directory)
{
    var files = Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
        .ToList();
    var text = string.Join("\n", files.Select(File.ReadAllText).Select(WithoutLiteralText));
    var imported = Regex.Matches(text, @"^using ([A-Za-z0-9_.]+);", RegexOptions.Multiline)
        .Select(m => m.Groups[1].Value)
        .ToHashSet();
    var words = Regex.Matches(text, @"(?<![\w.:])[A-Z][A-Za-z0-9_]*")
        .Select(m => m.Value)
        .ToHashSet();

    var assemblies = new Dictionary<string, Assembly>();
    void Load(Assembly a)
    {
        if (!assemblies.TryAdd(a.FullName!, a)) return;
        foreach (var reference in a.GetReferencedAssemblies())
        {
            try
            {
                Load(Assembly.Load(reference));
            }
            catch (FileNotFoundException)
            {
            }
        }
    }

    Load(generated);
    Load(typeof(object).Assembly);

    var found = new SortedSet<string>(StringComparer.Ordinal);
    foreach (var a in assemblies.Values)
    {
        Type[] types;
        try
        {
            types = a.GetExportedTypes();
        }
        catch (Exception)
        {
            continue;
        }

        foreach (var type in types.Where(t => !t.IsNested && t.Namespace is not null && imported.Contains(t.Namespace)))
        {
            var tick = type.Name.IndexOf('`');
            var name = tick < 0 ? type.Name : type.Name[..tick];
            var arity = type.IsGenericTypeDefinition ? type.GetGenericArguments().Length : 0;
            var attribute = typeof(Attribute).IsAssignableFrom(type) && name.EndsWith("Attribute", StringComparison.Ordinal)
                ? name[..^"Attribute".Length]
                : null;
            if (words.Contains(name) || (attribute is not null && words.Contains(attribute)))
            {
                found.Add($"{name} {arity} {type.Namespace}");
            }
        }
    }

    foreach (var line in found)
    {
        Console.WriteLine(line);
    }

    return 0;
}
