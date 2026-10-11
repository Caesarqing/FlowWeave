class Client:
    pass

def run(client: Client) -> object:
    return getattr(client, "fetch")()
