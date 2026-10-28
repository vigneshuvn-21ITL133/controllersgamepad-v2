using System.Security.Cryptography;
using System.Text.Json;

namespace WirelessController.Windows.Services;

public sealed class PairingManager
{
    private readonly object _gate = new();
    private string? _code;
    private DateTimeOffset _expiresAt;

    public (string Code, DateTimeOffset ExpiresAt) Create(TimeSpan? lifetime = null)
    {
        lock (_gate)
        {
            _code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
            // Matches the 5-minute lifetime shown in the UI and mobile instructions.
            _expiresAt = DateTimeOffset.UtcNow.Add(lifetime ?? TimeSpan.FromMinutes(5));
            return (_code, _expiresAt);
        }
    }

    public PairingConsumeResult TryConsumeDetailed(string? candidate)
    {
        lock (_gate)
        {
            if (_code is null) return PairingConsumeResult.MissingOrAlreadyUsed;
            if (DateTimeOffset.UtcNow >= _expiresAt)
            {
                _code = null;
                return PairingConsumeResult.Expired;
            }

            // Allow common formatting copied from the UI, but compare only six ASCII digits.
            candidate = candidate?.Trim()
                .Replace("-", string.Empty, StringComparison.Ordinal)
                .Replace(" ", string.Empty, StringComparison.Ordinal)
                .Replace("\u00A0", string.Empty, StringComparison.Ordinal);
            if (candidate is null || candidate.Length != 6 || candidate.Any(c => c < '0' || c > '9'))
                return PairingConsumeResult.Invalid;

            var expected = System.Text.Encoding.UTF8.GetBytes(_code);
            var actual = System.Text.Encoding.UTF8.GetBytes(candidate);
            if (!CryptographicOperations.FixedTimeEquals(expected, actual))
                return PairingConsumeResult.Invalid;

            _code = null; // successful codes are single-use
            return PairingConsumeResult.Accepted;
        }
    }

    public bool TryConsume(string? candidate) => TryConsumeDetailed(candidate) == PairingConsumeResult.Accepted;

    public void Clear()
    {
        lock (_gate) _code = null;
    }

    public bool IsExpired
    {
        get { lock (_gate) return _code is null || DateTimeOffset.UtcNow >= _expiresAt; }
    }
}

public enum PairingConsumeResult { Accepted, Invalid, Expired, MissingOrAlreadyUsed }

public sealed record PairMessage(string? Type, string? Code);
public sealed record InputMessage(string? Type, string[]? Buttons, Dictionary<string, double>? Axes);
public sealed record DesktopMessage(string? Type, string? Action, string? Key, bool? Down, string? Text, int? Dx, int? Dy, string? Button, int? Delta);
public sealed record PingMessage(string? Type, long ClientTime);
public sealed record PairingPayload(string Host, int Port, string Code, DateTimeOffset ExpiresAt, string Protocol);
