# Stage 1: build
FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS build
WORKDIR /src
COPY src/OrdersApi/OrdersApi.csproj src/OrdersApi/
RUN dotnet restore src/OrdersApi/OrdersApi.csproj
COPY src/ src/
RUN dotnet publish src/OrdersApi/OrdersApi.csproj \
    -c Release \
    -o /out \
    /p:DebugType=None

# Stage 2: runtime (distroless / chiseled)
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS runtime

LABEL org.opencontainers.image.title="orders-api" \
      org.opencontainers.image.description="Order aggregate service with transactional outbox pattern" \
      org.opencontainers.image.source="https://github.com/polyglot-sre-platform/orders-api" \
      org.opencontainers.image.version="1.0.0"

WORKDIR /app
COPY --from=build /out .
RUN adduser -u 1000 --disabled-password --gecos "" appuser
USER appuser
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "OrdersApi.dll"]
