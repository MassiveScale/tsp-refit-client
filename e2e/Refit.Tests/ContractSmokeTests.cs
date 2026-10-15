using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using AwesomeAssertions;
using MassiveScale.Testing;

namespace RefitClient.Tests;

/// <summary>
/// Every model and enum of every example client, written and read with the client's own
/// serializer settings (see <see cref="ContractSmoke"/>).
/// </summary>
[TestClass]
public sealed class ContractSmokeTests
{
    /// <summary>The assemblies built from the examples' generated code, with a model and enum each must contain.</summary>
    public static IEnumerable<object[]> Assemblies =>
    [
        [typeof(MassiveScale.KitchenSink.Client.KitchenSinkClient).Assembly, "Vehicle", "Color"],
        [typeof(MassiveScale.Simple.Api.Example.Client.ExampleClient).Assembly, "Widget", "WidgetColor"],
        [typeof(MassiveScale.AllVersions.Client.V1_0.AllVersionsClient).Assembly, "Pet", "Status"],
    ];

    [TestMethod]
    [DynamicData(nameof(Assemblies))]
    public void Every_model_and_enum_round_trips_through_the_client_serializer(Assembly assembly, string model, string enumName)
    {
        var (checkedTypes, failures) = ContractSmoke.Check(assembly);

        failures.Should().BeEmpty();
        checkedTypes.Should().Contain([model, enumName]);
    }

    [TestMethod]
    public void The_options_checked_are_the_ones_the_refit_content_serializer_holds()
    {
        var options = ContractSmoke.ClientJsonOptions(typeof(MassiveScale.KitchenSink.Client.KitchenSinkClient).Assembly);

        JsonSerializer.Serialize(TimeSpan.FromMinutes(90), options).Should().Be("\"PT1H30M\"", "the client writes ISO 8601 durations");
        JsonSerializer.Serialize(new { Absent = (string?)null }, options).Should().Be("{}", "the client leaves null properties out");
    }

    [TestMethod]
    public void A_record_with_two_properties_under_one_json_name_is_caught()
    {
        var (_, failures) = ContractSmoke.Check([typeof(Clashing)], JsonSerializerOptions.Default);

        failures.Should().ContainSingle().Which.Should().Contain(nameof(Clashing));
    }

    [TestMethod]
    public void A_record_whose_value_does_not_survive_a_round_trip_is_caught()
    {
        var (_, failures) = ContractSmoke.Check([typeof(Lossy)], JsonSerializerOptions.Default);

        failures.Should().ContainSingle().Which.Should().Contain("did not round-trip");
    }

    [TestMethod]
    public void A_subtype_read_back_as_its_base_is_caught()
    {
        var (_, failures) = ContractSmoke.Check([typeof(Unlisted)], JsonSerializerOptions.Default);

        failures.Should().ContainSingle().Which.Should().Contain("was read back as");
    }

    [TestMethod]
    public void A_working_record_passes()
    {
        var (checkedTypes, failures) = ContractSmoke.Check([typeof(Working)], JsonSerializerOptions.Default);

        failures.Should().BeEmpty();
        checkedTypes.Should().Equal(nameof(Working));
    }

    [TestMethod]
    public void A_subtype_sent_as_a_body_without_its_discriminator_is_caught()
    {
        var failures = ContractSmoke.CheckBodies([typeof(Shape)], new JsonSerializerOptions(), new RuntimeTypeSerializer());

        failures.Should().ContainSingle().Which.Should().Contain("Circle sent as a request body has \"kind\" missing");
    }

    [TestMethod]
    public void A_subtype_sent_as_a_body_with_its_discriminator_passes()
    {
        var failures = ContractSmoke.CheckBodies([typeof(Shape)], new JsonSerializerOptions(), new BaseTypeSerializer());

        failures.Should().BeEmpty();
    }

    /// <summary>A base with one listed subtype.</summary>
    [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
    [JsonDerivedType(typeof(Circle), "circle")]
    public abstract record Shape;

    /// <summary>The listed subtype of <see cref="Shape"/>.</summary>
    public record Circle : Shape
    {
        [JsonPropertyName("radius")] public int Radius { get; init; }
    }

    /// <summary>A content serializer that writes a body as its runtime type, which drops the discriminator.</summary>
    public sealed class RuntimeTypeSerializer
    {
        /// <summary>Writes the body as its runtime type.</summary>
        public HttpContent ToHttpContent<T>(T item) => new StringContent(JsonSerializer.Serialize(item, item!.GetType()));
    }

    /// <summary>A content serializer that writes a shape as <see cref="Shape"/>, which keeps the discriminator.</summary>
    public sealed class BaseTypeSerializer
    {
        /// <summary>Writes the body as its polymorphic base.</summary>
        public HttpContent ToHttpContent<T>(T item) => new StringContent(JsonSerializer.Serialize(item, typeof(Shape)));
    }

    /// <summary>Two properties System.Text.Json would write under one name.</summary>
    public record Clashing
    {
        [JsonPropertyName("x")] public string? A { get; init; }

        [JsonPropertyName("x")] public string? B { get; init; }
    }

    /// <summary>A property whose value changes every time it is written.</summary>
    public record Lossy
    {
        private static int s_writes;

        [JsonPropertyName("writes")]
        public int Writes => Interlocked.Increment(ref s_writes);
    }

    /// <summary>A base whose listed subtype is written without its own discriminator value.</summary>
    [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
    [JsonDerivedType(typeof(Unlisted), "base")]
    [JsonDerivedType(typeof(UnlistedChild))]
    public record Unlisted
    {
        public string? Name { get; init; }
    }

    /// <summary>A subtype listed without a discriminator value, so it is read back as its base.</summary>
    public record UnlistedChild : Unlisted;

    /// <summary>A record with nothing wrong.</summary>
    public record Working
    {
        [JsonPropertyName("name")] public string? Name { get; init; }
    }
}
