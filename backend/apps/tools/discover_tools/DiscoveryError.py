class DiscoveryError(Exception):
    """Raised when MCP tool discovery fails."""
    pass


class DiscoveryConfigError(DiscoveryError):
    """Raised for invalid discovery configuration (client error)."""
    pass